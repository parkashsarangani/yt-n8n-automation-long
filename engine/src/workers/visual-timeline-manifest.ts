import type { WorkerDef, WorkerOutput } from "../runner.ts";

interface AssetBeat {
  id: string;
  scene_index: number;
  status: "resolved" | "fallback" | "unavailable";
  resolved_mode: "stock_video" | "generated_image" | "motion_graphic" | "generated_video" | null;
  image_uri?: string;
  video_uri?: string;
  preview_uri?: string;
  template_category?: "explanation";
  template_data?: string;
}
interface AssetArtifact { beats: AssetBeat[] }
interface TimelineBeat {
  id: string;
  scene_index: number;
  duration_sec: number;
  image_uri?: string;
  video_uri?: string;
  preview_uri?: string;
  template_category?: "explanation";
  template_data?: string;
  continuity_group: string;
  narration: string;
}
interface VisualTimeline { beats: TimelineBeat[] }

/**
 * Compatibility manifest for the existing technical QA contract.
 *
 * Rendering does NOT use this flattened manifest. The production renderer uses
 * the RFC 0010 visual_timeline directly, preserving exact beat timing. This
 * artifact only lets the mature illustrated-story QA/publish path keep its
 * scene-level completeness checks while the real visual source of truth stays
 * the beat timeline.
 */
export function buildVisualTimelineManifest(assets: AssetArtifact, timeline: VisualTimeline): {
  scenes: Array<Record<string, unknown>>;
  degraded_count: number;
} {
  const assetById = new Map(assets.beats.map((beat) => [beat.id, beat]));
  const groups = new Map<number, TimelineBeat[]>();
  for (const beat of timeline.beats) {
    const asset = assetById.get(beat.id);
    if (!asset || asset.status === "unavailable" || !asset.resolved_mode) {
      throw new Error(`${beat.id}: production manifest cannot represent an unavailable visual beat`);
    }
    const list = groups.get(beat.scene_index) ?? [];
    list.push(beat);
    groups.set(beat.scene_index, list);
  }
  if (!groups.size) throw new Error("visual_timeline_manifest: no timeline scenes");

  const scenes = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([sceneIndex, beats]) => {
    const imageUris = [...new Set(beats.flatMap((beat) => beat.image_uri ? [beat.image_uri] : beat.preview_uri ? [beat.preview_uri] : []))].slice(0, 5);
    const firstVideo = beats.find((beat) => beat.video_uri)?.video_uri;
    const firstTemplate = beats.find((beat) => beat.template_category);
    const continuity = [...new Set(beats.map((beat) => beat.continuity_group).filter(Boolean))];
    const allTemplates = beats.every((beat) => beat.template_category === "explanation");
    return {
      scene_index: sceneIndex,
      source: allTemplates ? "template" : "primary",
      ...(imageUris[0] ? { image_uri: imageUris[0] } : {}),
      ...(imageUris.length ? { image_uris: imageUris } : {}),
      ...(firstVideo ? { video_uri: firstVideo } : {}),
      ...(allTemplates && firstTemplate ? { template_category: "explanation" } : {}),
      ...(allTemplates && firstTemplate?.template_data ? { template_data: firstTemplate.template_data } : {}),
      ...(continuity.length === 1 ? { continuity_group: continuity[0] } : {}),
      duration_sec: Number(beats.reduce((sum, beat) => sum + beat.duration_sec, 0).toFixed(3)),
      prompt: beats.map((beat) => beat.narration).join(" ").slice(0, 3000),
    };
  });
  return { scenes, degraded_count: 0 };
}

export function makeVisualTimelineManifestWorker(): WorkerDef {
  return {
    name: "visual_timeline_manifest",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "visual_beat_assets", range: "^1", as: "assets" },
      { schema_id: "visual_timeline", range: "^1", as: "timeline" },
    ],
    produces: "asset_manifest",
    produces_version: "1.9.0",
    async execute(inputs): Promise<WorkerOutput> {
      return {
        payload: buildVisualTimelineManifest(
          inputs["assets"]!.payload as AssetArtifact,
          inputs["timeline"]!.payload as VisualTimeline,
        ),
      };
    },
  };
}
