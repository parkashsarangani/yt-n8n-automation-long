import type { BlobRef } from "../artifact.ts";
import { checkGeneratedImageForText, checkGeneratedImageMatchesNarration } from "../image-qa.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import {
  selectVisualMode,
  validateVisualBeatPlan,
  type VisualBeat,
  type VisualBeatPlan,
  type VisualCapabilities,
  type VisualMode,
} from "../visual-routing.ts";

export interface VisualBeatAssetsWorkerOptions {
  version?: string;
}

interface ResolvedBeat {
  id: string;
  scene_index: number;
  beat_index: number;
  start_sec: number;
  end_sec: number;
  requested_mode: VisualMode;
  resolved_mode: VisualMode | null;
  status: "resolved" | "fallback" | "unavailable";
  semantic_verified: boolean;
  narration: string;
  viewer_takeaway: string;
  image_uri?: string;
  template_category?: "motion_graphic";
  template_data?: string;
  note?: string;
}

interface ModeResult extends Partial<ResolvedBeat> {
  blob?: BlobRef;
}

const BENCHMARK_CAPABILITIES: VisualCapabilities = Object.freeze({
  // RFC 0010 fails these modes closed until actual candidate frames and exact
  // clip segments are scored. Metadata-only search is not an implementation.
  stock_video: false,
  generated_image: true,
  motion_graphic: true,
  generated_video: false,
});

function promptForBeat(beat: VisualBeat, repair = false): string {
  const required = beat.visual_contract.required.join("; ");
  const forbidden = beat.visual_contract.forbidden.join("; ");
  const action = beat.visual_contract.required_action.trim();
  const base = [
    beat.asset_brief.generation_prompt,
    `NARRATION JOB: ${beat.visual_contract.viewer_takeaway}.`,
    `MUST VISIBLY INCLUDE: ${required}.`,
    action ? `MUST VISIBLY SHOW ACTION/STATE: ${action}.` : "",
    forbidden ? `DO NOT SHOW: ${forbidden}.` : "",
    `COMPOSITION: ${beat.retention.composition}.`,
    beat.continuity.group ? `CONTINUITY GROUP: ${beat.continuity.group}; recurring entities: ${beat.continuity.entities.join(", ") || "none"}.` : "",
    "No readable text, letters, numbers, logos, watermarks, captions, or UI typography unless the visual meaning absolutely requires a symbolic mark; prefer non-text visual communication.",
  ].filter(Boolean).join(" ");
  return repair
    ? `${base} REPAIR: the previous candidate failed visual QA. Make the required subject/action unmistakable at first glance and remove any accidental typography or narration contradiction.`
    : base;
}

async function generateVerifiedImage(
  beat: VisualBeat,
  ctx: WorkerContext,
): Promise<{ ref: BlobRef; semanticVerified: boolean }> {
  const provider = ctx.media.images;
  if (!provider) throw new Error("RFC 0010 generated_image route requires an image provider");
  if (provider.id.toLowerCase().includes("freellmapi")) {
    throw new Error(`RFC 0010 forbids FreeLLMAPI image generation; configured provider is ${provider.id}`);
  }

  let lastFailure = "image generation failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = promptForBeat(beat, attempt > 0);
    const out = await provider.generate({ prompt, aspect: "16:9", count: 1, tier: beat.hero_role ? "hero" : "standard" });
    const image = out.images[0];
    if (!image) {
      lastFailure = "provider returned no image";
      continue;
    }

    const [textQa, semanticQa] = await Promise.all([
      checkGeneratedImageForText(image),
      checkGeneratedImageMatchesNarration(image, beat.narration),
    ]);

    // Benchmark path fails closed. The old production path deliberately lets
    // vision outages pass; RFC 0010 cannot measure semantic quality that way.
    if (!textQa || !semanticQa) {
      lastFailure = "visual QA unavailable; candidate was not admitted unverified";
      continue;
    }
    if (textQa.hasVisibleText) {
      lastFailure = `visible text: ${textQa.reason}`;
      continue;
    }
    if (semanticQa.contradictsNarration) {
      lastFailure = `narration contradiction: ${semanticQa.reason}`;
      continue;
    }

    const ref = await ctx.blobs.put(image.bytes, { role: "image", media_type: image.media_type });
    return { ref, semanticVerified: true };
  }

  throw new Error(lastFailure);
}

function motionGraphic(beat: VisualBeat): ModeResult {
  const brief = beat.asset_brief.motion_graphic_brief.trim();
  if (!brief) throw new Error(`${beat.id}: motion_graphic route has no deterministic brief`);
  return {
    template_category: "motion_graphic",
    template_data: JSON.stringify({
      brief,
      required: beat.visual_contract.required,
      required_action: beat.visual_contract.required_action,
      forbidden: beat.visual_contract.forbidden,
      viewer_takeaway: beat.visual_contract.viewer_takeaway,
      composition: beat.retention.composition,
      continuity: beat.continuity,
    }),
    // The representation is declared, not yet rendered. Marking it verified
    // would pretend that a frame was inspected, which RFC 0010 forbids.
    semantic_verified: false,
  };
}

async function resolveMode(
  beat: VisualBeat,
  mode: VisualMode,
  ctx: WorkerContext,
): Promise<ModeResult> {
  if (mode === "generated_image") {
    const generated = await generateVerifiedImage(beat, ctx);
    return {
      image_uri: generated.ref.uri,
      semantic_verified: generated.semanticVerified,
      blob: generated.ref,
    };
  }
  if (mode === "motion_graphic") return motionGraphic(beat);
  throw new Error(`${beat.id}: ${mode} is disabled until frame-level candidate verification is implemented`);
}

function alternateMode(beat: VisualBeat, current: VisualMode): VisualMode | null {
  if (current === beat.routing.preferred) return beat.routing.fallback;
  if (current === beat.routing.fallback) return beat.routing.preferred;
  return null;
}

export function makeVisualBeatAssetsWorker(opts: VisualBeatAssetsWorkerOptions = {}): WorkerDef {
  return {
    name: "visual_beat_assets",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [{ schema_id: "visual_beat_plan", range: "^1", as: "plan" }],
    produces: "visual_beat_assets",
    produces_version: "1.0.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const plan = inputs["plan"]!.payload as VisualBeatPlan;
      const validationErrors = validateVisualBeatPlan(plan);
      if (validationErrors.length) {
        throw new Error(`visual beat plan invariant failed: ${validationErrors.join("; ")}`);
      }

      const ordered = [...plan.beats].sort((a, b) =>
        a.scene_index - b.scene_index || a.beat_index - b.beat_index,
      );
      const recentModes: VisualMode[] = [];
      const blobs: BlobRef[] = [];
      const beats: ResolvedBeat[] = [];

      for (const beat of ordered) {
        const requested = beat.routing.preferred;
        let selected = selectVisualMode(beat, recentModes, BENCHMARK_CAPABILITIES);
        let result: ModeResult | null = null;
        let note = "";

        if (selected) {
          try {
            result = await resolveMode(beat, selected, ctx);
          } catch (err) {
            note = err instanceof Error ? err.message : String(err);
            const alternate = alternateMode(beat, selected);
            if (alternate && BENCHMARK_CAPABILITIES[alternate]) {
              try {
                selected = alternate;
                result = await resolveMode(beat, selected, ctx);
                note = `primary route failed; used declared alternate: ${note}`;
              } catch (fallbackErr) {
                note = `${note}; alternate failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`;
                selected = null;
              }
            } else {
              selected = null;
            }
          }
        } else {
          note = "neither preferred nor fallback mode is currently benchmark-capable";
        }

        if (result?.blob) blobs.push(result.blob);

        const resolved: ResolvedBeat = {
          id: beat.id,
          scene_index: beat.scene_index,
          beat_index: beat.beat_index,
          start_sec: beat.start_sec,
          end_sec: beat.end_sec,
          requested_mode: requested,
          resolved_mode: selected,
          status: selected ? (selected === requested ? "resolved" : "fallback") : "unavailable",
          semantic_verified: Boolean(result?.semantic_verified),
          narration: beat.narration,
          viewer_takeaway: beat.visual_contract.viewer_takeaway,
          ...(result?.image_uri ? { image_uri: result.image_uri } : {}),
          ...(result?.template_category ? { template_category: result.template_category } : {}),
          ...(result?.template_data ? { template_data: result.template_data } : {}),
          ...(note ? { note } : {}),
        };

        if (selected) recentModes.push(selected);
        beats.push(resolved);
      }

      const summary = {
        resolved: beats.filter((beat) => beat.status === "resolved").length,
        fallbacks: beats.filter((beat) => beat.status === "fallback").length,
        unavailable: beats.filter((beat) => beat.status === "unavailable").length,
        generated_images: beats.filter((beat) => beat.resolved_mode === "generated_image").length,
        motion_graphics: beats.filter((beat) => beat.resolved_mode === "motion_graphic").length,
      };

      return { payload: { beats, summary }, blobs };
    },
  };
}
