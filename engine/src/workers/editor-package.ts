/**
 * Editor-package worker: approved script + voice + the draft render -> a
 * Drive folder the human editor can pick up from, plus the same beat list
 * recorded on the artifact so the operator can review it without opening
 * Drive.
 *
 * The editor never sees thumbnail/SEO/title -- only the video and what it
 * needs to judge and replace a weak visual moment.
 */
import type { Artifact } from "../artifact.ts";
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

interface FootageCredit {
  id: string;
  creator: string;
  source_url: string;
  license_url: string;
  credit: string;
  sha256: string;
  scene_index?: number;
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
  if (credit) return `Footage: ${credit.credit}`;
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
    version: opts.version ?? "1",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "rendered_video", range: "^1", as: "render" },
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
      const folderName = new Date().toISOString().slice(0, 10);
      const folderId = await drive.createFolder(folderName, rootFolderId);

      const videoBytes = await ctx.blobs.get(render.video_uri);
      await drive.uploadFile(folderId, "draft.mp4", videoBytes, render.media_type || "video/mp4");

      const packageMd = [
        `# Episode draft — ${folderName}`,
        "",
        "Export your finished cut as `final.mp4` and upload it into this same folder when done.",
        "Swap out any visual that doesn't fit; general polish is welcome. This is a light touch-up pass, not a rebuild.",
        "",
        "## Transcript and visual beats",
        "",
        ...beats.flatMap((b) => [
          `**${formatClock(b.start_sec)}–${formatClock(b.start_sec + b.duration_sec)}** (scene ${b.scene_index}) — ${escapeMd(b.point)}`,
          `- Current visual: ${escapeMd(b.visual_summary)}`,
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
      await drive.uploadFile(folderId, "package.md", new TextEncoder().encode(packageMd), "text/markdown");

      const creditsJson = JSON.stringify({ existing_footage_credits: credits, new_assets_used: [] }, null, 2);
      await drive.uploadFile(folderId, "credits.json", new TextEncoder().encode(creditsJson), "application/json");

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
