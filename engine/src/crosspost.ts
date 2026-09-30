/**
 * Cross-post a published Short to Facebook and Instagram Reels (Shorts phase
 * 2, 2026-09-29). A separate scheduler job, NOT graph nodes: runs resolve to
 * the current graph and completed nodes are matched by graph version, so new
 * nodes would make every parked run forget its completed work. Being separate
 * also means a Meta failure can never block or duplicate the YouTube publish.
 *
 * Per run and platform the outcome is a run-log record (node_id
 * "crosspost_<target>", graph_id null -- ignored by run reconstruction):
 * a "running" marker is written BEFORE each upload, then "ok" (output = the
 * Reel URL) or "failed". A run whose last record is "running" crashed
 * mid-upload: it is never retried automatically -- a second upload could
 * double-post -- and a human is alerted instead.
 *
 * Captions are per platform (reel-captions.ts, operator 2026-09-29): short
 * clickbait lines, never the long YouTube description.
 */

import type { RunRecord } from "./runlog.ts";
import type { ReelsTarget } from "./providers/meta-reels.ts";

export const CROSSPOST_MAX_ATTEMPTS = 3;
/** Instagram's caption limit. */
export const REEL_CAPTION_MAX = 2200;

export interface CrosspostCandidate {
  run_id: string;
  video: () => Promise<Uint8Array>;
  media_type: string;
  seo: { title: string; description: string; tags?: string[] };
  /** Per-platform captions, fetched once and only when something is posted. */
  captions?: () => Promise<Partial<Record<string, string>>>;
}

/** "waiting": needs the public Facebook copy of the video, which is not there yet. */
export type CrosspostOutcome = "posted" | "failed" | "gave_up" | "uncertain" | "done" | "waiting";

function ownSettled(history: RunRecord[], id: string): boolean {
  const mine = history.filter((r) => r.node_id === `crosspost_${id}`);
  return mine.some((r) => r.status === "ok") || mine.at(-1)?.status === "running"
    || mine.filter((r) => r.status === "failed").length >= CROSSPOST_MAX_ATTEMPTS;
}

/**
 * The public source a video_url target (Instagram-login) is waiting for can
 * never come: no Facebook target, or Facebook finished without posting.
 */
function sourceUnavailable(history: RunRecord[], targets: ReelsTarget[]): boolean {
  if (!targets.some((t) => t.id === "facebook")) return true;
  const fbPosted = history.some((r) => r.node_id === "crosspost_facebook" && r.status === "ok");
  return !fbPosted && ownSettled(history, "facebook");
}

/** Nothing more will ever be done for this target on this run -- for the cheap pre-filter. */
export function crosspostSettled(history: RunRecord[], target: ReelsTarget, targets: ReelsTarget[]): boolean {
  return ownSettled(history, target.id) || (!!target.needsVideoUrl && sourceUnavailable(history, targets));
}

/** Last-resort caption: the title and a few hashtags -- never the description. */
export function reelCaption(seo: CrosspostCandidate["seo"]): string {
  const tags = (seo.tags ?? [])
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length > 1)
    .slice(0, 5)
    .map((t) => `#${t}`);
  const text = `${seo.title}${tags.length ? `\n\n${tags.join(" ")}` : ""}`.trim();
  return text.length <= REEL_CAPTION_MAX ? text : `${text.slice(0, REEL_CAPTION_MAX - 1).trimEnd()}…`;
}

export interface CrosspostDeps {
  targets: ReelsTarget[];
  records: (runId: string) => Promise<RunRecord[]>;
  record: (r: RunRecord) => Promise<void>;
  alert: (runId: string, reason: string, error: string) => Promise<void>;
  /** A public URL of the video, from the run's Facebook Reel, for targets that need one. */
  videoUrl?: (history: RunRecord[]) => Promise<string | undefined>;
  now?: () => Date;
}

/** Post one run to every configured target that has not finished yet. */
export async function crosspostRun(c: CrosspostCandidate, deps: CrosspostDeps): Promise<Record<string, CrosspostOutcome>> {
  const out: Record<string, CrosspostOutcome> = {};
  const history = await deps.records(c.run_id);
  let video: Uint8Array | undefined;
  let captions: Partial<Record<string, string>> | undefined;
  for (const target of deps.targets) {
    const node = `crosspost_${target.id}`;
    const mine = history.filter((r) => r.node_id === node);
    if (mine.some((r) => r.status === "ok")) { out[target.id] = "done"; continue; }
    if (mine.at(-1)?.status === "running") { out[target.id] = "uncertain"; continue; }
    const failures = mine.filter((r) => r.status === "failed").length;
    if (failures >= CROSSPOST_MAX_ATTEMPTS) { out[target.id] = "gave_up"; continue; }

    // Instagram-login tokens cannot take uploaded bytes: Instagram fetches the
    // video from a public URL -- the Facebook Reel posted just before. Waiting
    // for it is not an attempt; nothing is recorded until there is a URL.
    let videoUrl: string | undefined;
    if (target.needsVideoUrl) {
      const fresh = await deps.records(c.run_id);
      if (sourceUnavailable(fresh, deps.targets)) { out[target.id] = "gave_up"; continue; }
      videoUrl = deps.videoUrl ? await deps.videoUrl(fresh).catch(() => undefined) : undefined;
      if (!videoUrl) { out[target.id] = "waiting"; continue; }
    }

    const base = {
      run_id: c.run_id, graph_id: null, node_id: node, transformation: target.id, transformation_version: "1",
      inputs: [], attempt: failures + 1, max_attempts: CROSSPOST_MAX_ATTEMPTS, duration_ms: 0,
    };
    const started = (deps.now ?? (() => new Date()))();
    await deps.record({ ...base, output: null, status: "running", started_at: started.toISOString() });
    try {
      video ??= await c.video();
      captions ??= c.captions ? await c.captions().catch(() => ({})) : {};
      const caption = captions[target.id]?.trim() || reelCaption(c.seo);
      const result = await target.post({ video, media_type: c.media_type, caption, title: c.seo.title, ...(videoUrl ? { video_url: videoUrl } : {}) });
      await deps.record({ ...base, output: result.url, status: "ok", started_at: started.toISOString(),
        duration_ms: Date.now() - started.getTime(), provider: target.id, model: result.external_id });
      out[target.id] = "posted";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await deps.record({ ...base, output: null, status: "failed", error: detail.slice(0, 1000), started_at: started.toISOString() });
      if (failures + 1 >= CROSSPOST_MAX_ATTEMPTS) {
        await deps.alert(c.run_id, `the Short could not be posted to ${target.id} after ${CROSSPOST_MAX_ATTEMPTS} attempts`, detail);
        out[target.id] = "gave_up";
      } else {
        out[target.id] = "failed";
      }
    }
  }
  return out;
}
