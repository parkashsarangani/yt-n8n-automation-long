/**
 * Publish worker: rendered_video + seo_metadata + thumbnail + qa_report -> published_episode.
 *
 * Reads the target's `requirements()` rather than knowing anything about a
 * specific platform — this is the seam that keeps YouTube a plugin. Swapping in
 * a podcast or blog target changes the constructor argument and nothing else.
 *
 * Validation is up-front and fatal. Publishing is the one irreversible step in
 * the graph, so a title that will not fit stops the run *before* upload rather
 * than being quietly truncated into something the story never meant.
 */

import type { PublishMetadata, PublishTarget } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import { episodeChapters, hasChapterStart } from "../chapters.ts";

export interface PublishWorkerOptions {
  target: PublishTarget;
  privacy?: "public" | "unlisted" | "private";
  madeForKids?: boolean;
  version?: string;
}

interface SeoMetadata {
  title: string;
  description: string;
  tags: string[];
  primary_keyword: string;
}

interface QaReport {
  verdict: "pass" | "fail";
  failed: number;
  warned?: number;
  checks: Array<{ id: string; status: string; message: string }>;
}

/**
 * Warnings that stay in the QA report but never hold an episode back from
 * going public. Length drift is a target, not a defect: the script writer
 * routinely overshoots and the editor re-cuts anyway, and episode 1 of
 * Second Thoughts sat private for a 17% overshoot with every other check clean.
 */
const ADVISORY_WARNINGS = new Set(["target_duration"]);

/** A clean QA result: the verdict passed AND nothing beyond an advisory check was flagged. */
function qaIsClean(qa: QaReport): boolean {
  if (qa.verdict !== "pass") return false;
  const warns = (qa.checks ?? []).filter((c) => c.status === "warn");
  // A report whose warned count disagrees with its checks can't be trusted to
  // say which warnings were advisory; fall back to treating any as blocking.
  if ((qa.warned ?? warns.length) !== warns.length) return (qa.warned ?? 0) === 0;
  return warns.every((c) => ADVISORY_WARNINGS.has(c.id));
}

interface ThumbnailArtifact {
  thumbnail_uri: string;
  media_type: "image/png" | "image/jpeg";
  bytes?: number;
}

interface RenderedVideo {
  video_uri: string;
  media_type: string;
  thumbnail_uri?: string;
  duration_sec?: number;
  /** "editor" when a human returned this cut, which also outranks our thumbnail. */
  renderer?: string;
}

export function makePublishWorker(opts: PublishWorkerOptions): WorkerDef {
  const target = opts.target;

  return {
    name: "publish",
    kind: "worker",
    version: opts.version ?? "5",
    consumes: [
      { schema_id: "rendered_video", range: "^1", as: "video" },
      { schema_id: "seo_metadata", range: "^1", as: "seo" },
      { schema_id: "thumbnail", range: "^1", as: "thumbnail" },
      { schema_id: "qa_report", range: "^1", as: "qa" },
      { schema_id: "script", range: "^1", as: "script", optional: true },
      { schema_id: "voice", range: "^1", as: "voice", optional: true },
    ],
    produces: "published_episode",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const video = inputs["video"]!.payload as RenderedVideo;
      const seo = inputs["seo"]!.payload as SeoMetadata;
      const reqs = target.requirements();

      // publish() does not judge whether to upload at all -- that decision
      // belongs entirely to approve_publish upstream, and it auto-passes
      // regardless of the QA verdict (RFC 0008 addendum: unattended daily
      // production has no human watching to catch a bad episode). Real
      // production evidence: a QA-failed episode (3/27 scenes missing their
      // asset) went straight to public with nobody reviewing it. This one
      // narrow exception reads the verdict for visibility only, never to
      // block: ANY non-clean QA verdict (fail OR warn) uploads private instead
      // of the configured default, so a genuinely broken or questionable
      // episode isn't live until an operator reviews it and flips it public in
      // Studio. Only a clean "pass" publishes at the configured privacy,
      // unattended.
      const qa = inputs["qa"]!.payload as QaReport;
      const privacy = qaIsClean(qa) ? (opts.privacy ?? "private") : "private";

      // Taken wholesale from the SEO artifact. This worker deliberately does no
      // fallback logic: it used to reach into the story and substitute the
      // payoff for a missing description, which is a decision, and decisions
      // belong to an agent (RFC 0003 rule 1 — workers never think).
      const metadata: PublishMetadata = {
        title: seo.title,
        description: seo.description,
        tags: seo.tags,
        privacy,
        made_for_kids: opts.madeForKids ?? false,
      };
      const creditsBlob=inputs["video"]!.blobs?.find(blob=>blob.role==="footage_credits");
      let chapterSuffix = "";
      if (inputs["script"] && inputs["voice"] && !hasChapterStart(seo.description)) {
        const scenes = (inputs["script"].payload as { scenes: Array<{scene_index:number; point?:string}> }).scenes;
        const clips = (inputs["voice"].payload as { clips: Array<{scene_index:number; duration_sec:number}> }).clips;
        const chapters = episodeChapters(scenes, clips);
        if (chapters) chapterSuffix = `\n\nChapters\n${chapters}`;
      }
      if(creditsBlob){
        const credits=JSON.parse(new TextDecoder().decode(await ctx.blobs.get(creditsBlob.uri))) as Array<{credit:string;source_url:string;license_url:string}>;
        const unique=[...new Map(credits.map(c=>[c.source_url,c])).values()];
        const text=unique.map(c=>`${c.credit}\n${c.source_url}\nLicense: ${c.license_url}`).join("\n\n");
        const suffix=`\n\nIllustrative footage (not footage of the narrated events):\n${text}`;
        const limit=reqs.max_description_chars??Infinity;
        let description=(metadata.description||"")+chapterSuffix+suffix;
        if(description.length>limit && chapterSuffix){
          ctx.logger.warn("measured chapters omitted: description would exceed target limit");
          description=(metadata.description||"")+suffix;
        }
        if(description.length>limit)
          throw Error("Required footage credits exceed description limit with approved prose; shorten the SEO description before publishing");
        metadata.description=description;
      }
      if (!creditsBlob && chapterSuffix) {
        // Do not duplicate existing operator/SEO chapters or truncate an approved description.
        const description = `${metadata.description}${chapterSuffix}`;
        if (description.length <= (reqs.max_description_chars ?? Infinity)) metadata.description = description;
        else ctx.logger.warn("measured chapters omitted: description would exceed target limit");
      }

      if (!qaIsClean(qa) && privacy !== (opts.privacy ?? "private")) {
        ctx.logger.warn(
          `[publish] qa_report is not clean (verdict=${qa.verdict}, ${qa.failed} failed, ${qa.warned ?? "?"} warned) -- ` +
            `publishing private instead of ${opts.privacy ?? "private"} so an operator reviews it before it goes public`,
        );
      }

      assertFits(metadata, video, reqs, target.id);

      const bytes = await ctx.blobs.get(video.video_uri);
      // This repository's production programme is 16:9 1080p. Read geometry
      // from the actual MP4 bytes immediately before the irreversible upload;
      // renderer metadata or filenames cannot hide a 720p regression.
      if (target.id === "youtube" && video.media_type === "video/mp4") {
        assertYouTubeProductionGeometry(bytes);
      }

      // The designed thumbnail wins over whatever the video render happened to
      // emit: it was reasoned about, and the render's is a by-product. The one
      // exception is a human editor's own thumbnail, returned alongside their
      // cut -- a person chose that over ours, so it outranks both.
      const designed = inputs["thumbnail"]?.payload as ThumbnailArtifact | undefined;
      const editorThumbnail = video.renderer === "editor" ? video.thumbnail_uri : undefined;
      const thumbSource = editorThumbnail
        ? {
            uri: editorThumbnail,
            // The real type travels on the blob; the payload has no field for it.
            media_type: inputs["video"]!.blobs?.find((b) => b.uri === editorThumbnail)?.media_type ?? "image/png",
          }
        : designed?.thumbnail_uri
          ? { uri: designed.thumbnail_uri, media_type: designed.media_type }
          : video.thumbnail_uri
            ? { uri: video.thumbnail_uri, media_type: "image/png" }
            : null;

      const thumbnail =
        thumbSource && reqs.supports_custom_thumbnail
          ? {
              bytes: await ctx.blobs.get(thumbSource.uri),
              media_type: thumbSource.media_type,
            }
          : undefined;

      await ctx.progress({ detail: `publishing to ${target.id}` });

      const result = await target.publish(
        {
          video: bytes,
          media_type: video.media_type,
          ...(thumbnail ? { thumbnail } : {}),
          metadata,
          ...(video.duration_sec !== undefined ? { duration_sec: video.duration_sec } : {}),
        },
        { onProgress: (detail) => ctx.progress({ detail }) },
      );

      if (thumbnail && !result.thumbnail_set) {
        // Visible, not silent: an auto-selected frame instead of the designed
        // thumbnail materially changes click-through.
        ctx.logger.warn(
          `[publish] ${target.id} did not accept the custom thumbnail for ${result.external_id}`,
        );
      }

      return {
        payload: {
          target: target.id,
          external_id: result.external_id,
          url: result.url,
          title: metadata.title,
          published_at: new Date().toISOString(),
          synthetic_media_disclosed: result.synthetic_media_disclosed,
          thumbnail_set: result.thumbnail_set,
          privacy: metadata.privacy,
        },
      };
    },
  };
}

function assertFits(
  metadata: PublishMetadata,
  video: RenderedVideo,
  reqs: ReturnType<PublishTarget["requirements"]>,
  targetId: string,
): void {
  const problems: string[] = [];

  if (metadata.title.length > reqs.max_title_chars) {
    problems.push(
      `title is ${metadata.title.length} chars, ${targetId} allows ${reqs.max_title_chars}`,
    );
  }
  if (
    reqs.max_description_chars !== undefined &&
    (metadata.description?.length ?? 0) > reqs.max_description_chars
  ) {
    problems.push(
      `description is ${metadata.description!.length} chars, ` +
        `${targetId} allows ${reqs.max_description_chars}`,
    );
  }
  if (reqs.max_tags !== undefined && (metadata.tags?.length ?? 0) > reqs.max_tags) {
    problems.push(`${metadata.tags!.length} tags, ${targetId} allows ${reqs.max_tags}`);
  }
  // The aggregate budget, which is the one that actually rejects uploads. A
  // legal tag count can still be an illegal payload.
  if (reqs.max_tag_chars !== undefined) {
    const total = (metadata.tags ?? []).reduce((n, t) => n + t.length, 0);
    if (total > reqs.max_tag_chars) {
      problems.push(
        `tags total ${total} characters, ${targetId} allows ${reqs.max_tag_chars}`,
      );
    }
  }
  if (
    reqs.max_duration_sec !== undefined &&
    video.duration_sec !== undefined &&
    video.duration_sec > reqs.max_duration_sec
  ) {
    problems.push(
      `video is ${video.duration_sec}s, ${targetId} allows ${reqs.max_duration_sec}s`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`publish to ${targetId} rejected before upload: ${problems.join("; ")}`);
  }
}
