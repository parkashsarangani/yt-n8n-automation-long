/**
 * Editor-package worker: approved script + voice + the draft render + the
 * already-produced thumbnail/SEO metadata -> a Drive folder the human editor
 * can pick up from, plus the same beat list recorded on the artifact so the
 * operator can review it without opening Drive.
 *
 * The editor never edits thumbnail/SEO/title -- those are handed over as
 * reference context alongside the draft, not something they're expected to
 * touch. Only the video comes back changed.
 */
import type { Artifact } from "../artifact.ts";
import type { FootageCredit } from "../provider.ts";
import { createHash } from "node:crypto";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface EditorPackageWorkerOptions {
  /** Drive folder id every per-episode subfolder is created under. */
  rootFolderId?: string;
  version?: string;
}

interface ScriptScene {
  scene_index: number;
  point: string;
  narration: string;
  is_outro?: boolean;
  visual?: { kind: "quote" | "comparison" | "steps"; title: string; items: string[] };
}

interface VoiceClip {
  scene_index: number;
  duration_sec: number;
}

interface SeoMetadata {
  title: string;
  description: string;
  tags: string[];
}

interface ThumbnailArtifact {
  thumbnail_uri: string;
  media_type: "image/png" | "image/jpeg";
  background?: "supplied" | "gradient";
}

const STOPWORDS = new Set([
  "the", "and", "you", "your", "with", "that", "this", "for", "from", "one",
  "then", "them", "they", "what", "when", "into", "have", "will", "was",
  "were", "are", "not", "but", "his", "her", "she", "him", "who", "how",
]);

function words(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Salient narration keywords, for a scene where no strong footage match exists. */
function searchTerms(narration: string, max = 6): string[] {
  const counts = new Map<string, number>();
  for (const w of words(narration)) {
    if (w.length <= 2 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

function visualSummary(scene: ScriptScene, credit: FootageCredit | undefined): string {
  if (credit) return `${credit.needs_review ? "Suggested stock (keep or replace)" : "Footage"}: ${credit.credit}${credit.query ? `; search: ${credit.query}` : ""}`;
  if (scene.visual) {
    const kind = scene.visual.kind;
    return `${kind[0]!.toUpperCase()}${kind.slice(1)} card: "${scene.visual.title}"`;
  }
  return "Plain graphics background";
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+.!-]/g, "\\$&");
}

function formatClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function makeEditorPackageWorker(opts: EditorPackageWorkerOptions = {}): WorkerDef {
  return {
    name: "editor_package",
    kind: "worker",
    version: opts.version ?? "4",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "rendered_video", range: "^1", as: "render" },
      { schema_id: "seo_metadata", range: "^1", as: "seo" },
      { schema_id: "thumbnail", range: "^1", as: "thumbnail" },
    ],
    produces: "editor_handoff",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const drive = ctx.media.drive;
      if (!drive) throw new Error("editor_package worker requires a Drive provider (media.drive)");
      const rootFolderId = opts.rootFolderId?.trim();
      if (!rootFolderId) throw new Error("editor_package worker requires DRIVE_ROOT_FOLDER_ID");

      const scenes = ((inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes)
        .slice()
        .sort((a, b) => a.scene_index - b.scene_index);
      const clips = (inputs["voice"]!.payload as { clips: VoiceClip[] }).clips;
      const durationBy = new Map(clips.map((c) => [c.scene_index, c.duration_sec]));
      const render = inputs["render"]!.payload as { video_uri: string; media_type: string };
      const seo = inputs["seo"]!.payload as SeoMetadata;
      const thumbnail = inputs["thumbnail"]!.payload as ThumbnailArtifact;

      const creditsBlob = inputs["render"]!.blobs?.find((b) => b.role === "footage_credits");
      const credits: FootageCredit[] = creditsBlob
        ? JSON.parse(new TextDecoder().decode(await ctx.blobs.get(creditsBlob.uri)))
        : [];
      const creditBySceneIndex = new Map(credits.filter((c) => c.scene_index !== undefined).map((c) => [c.scene_index!, c]));

      let elapsed = 0;
      const beats = scenes.map((scene) => {
        const duration = durationBy.get(scene.scene_index) ?? 0;
        const start = elapsed;
        elapsed += duration;
        const credit = creditBySceneIndex.get(scene.scene_index);
        const needsSearchTerms = !scene.is_outro && !credit;
        return {
          scene_index: scene.scene_index,
          point: scene.point,
          start_sec: start,
          duration_sec: duration,
          visual_summary: visualSummary(scene, credit),
          ...(needsSearchTerms && searchTerms(scene.narration).length ? { search_terms: searchTerms(scene.narration) } : {}),
        };
      });

      // Folder named by date so the editor can find it without a run id.
      const folderName = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      // Stable per-render identity lets a failed multipart upload resume without
      // creating a second episode folder or duplicating completed files.
      const deliveryName = `${folderName}-${createHash("sha256").update(render.video_uri).digest("hex").slice(0, 12)}`;
      const priorFolder = (await drive.listFiles(rootFolderId)).find(f => f.name === deliveryName && f.mimeType === "application/vnd.google-apps.folder");
      const folderId = priorFolder?.id ?? await drive.createFolder(deliveryName, rootFolderId);
      const uploaded = new Set((await drive.listFiles(folderId)).map(f => f.name));
      const upload = async (name: string, bytes: Uint8Array, mime: string) => {
        if (!uploaded.has(name)) await drive.uploadFile(folderId, name, bytes, mime);
      };

      const videoBytes = await ctx.blobs.get(render.video_uri);
      await upload("draft.mp4", videoBytes, render.media_type || "video/mp4");
      const captions = inputs["render"]!.blobs?.find(b => b.role === "captions");
      if (captions) await upload("captions.srt", await ctx.blobs.get(captions.uri), "application/x-subrip");

      const thumbnailBytes = await ctx.blobs.get(thumbnail.thumbnail_uri);
      const thumbnailExt = thumbnail.media_type === "image/jpeg" ? "jpg" : "png";
      await upload(`thumbnail.${thumbnailExt}`, thumbnailBytes, thumbnail.media_type);

      const packageMd = [
        `# Episode draft — ${folderName}`,
        "",
        "Export your finished cut as `final.mp4` and upload it into this same folder when done.",
        "Keep useful stock shots and replace any weak or misleading match with your own images/footage. Stock illustrates a situation; it does not depict the actual narrated people or events. Background-only scenes still need your visual treatment.",
        "Preserve the narration timing and readable captions. captions.srt matches the draft captions; if you retime the cut, retime the captions too.",
        "The title and description below are reference context. Only final.mp4 is automatically imported from this folder.",
        thumbnail.background === "gradient"
          ? "THUMBNAIL NEEDS REPLACEMENT: artwork was unavailable or rejected. thumbnail.png is a placeholder; flag it to the operator for replacement before publication. Editing it here does not automatically update the publishing thumbnail."
          : "The thumbnail below is the automated candidate; flag any issue to the operator before publication.",
        "",
        "## Title, thumbnail and description (for context)",
        "",
        `**Title:** ${escapeMd(seo.title)}`,
        "",
        "**Thumbnail:** see `thumbnail." + thumbnailExt + "` in this folder.",
        "",
        `**Description:** ${escapeMd(seo.description)}`,
        "",
        `**Tags:** ${seo.tags.join(", ")}`,
        "",
        "## Transcript and visual beats",
        "",
        ...beats.flatMap((b) => [
          `**${formatClock(b.start_sec)}–${formatClock(b.start_sec + b.duration_sec)}** (scene ${b.scene_index}) — ${escapeMd(b.point)}`,
          `- Current visual: ${escapeMd(b.visual_summary)}`,
          `- Narration: ${escapeMd(scenes.find(s => s.scene_index === b.scene_index)!.narration)}`,
          ...(b.search_terms ? [`- Suggested search terms: ${b.search_terms.join(", ")}`] : []),
          "",
        ]),
        "## Licensing/credit fields for any new asset you add",
        "",
        "If you replace a visual with your own footage/photo, list it here so it can be credited:",
        "",
        "- Source URL:",
        "- License URL:",
        "- Creator/attribution text:",
        "",
      ].join("\n");
      await upload("package.md", new TextEncoder().encode(packageMd), "text/markdown");

      const creditsJson = JSON.stringify({ existing_footage_credits: credits, new_assets_used: [] }, null, 2);
      await upload("credits.json", new TextEncoder().encode(creditsJson), "application/json");

      return {
        payload: {
          drive_folder_id: folderId,
          drive_folder_url: drive.folderUrl(folderId),
          scenes: beats,
        },
      };
    },
  };
}
