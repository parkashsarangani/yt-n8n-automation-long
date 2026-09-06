import type { BlobRef } from "../artifact.ts";
import { alignVisualBeatPlan, type VoiceClipForAlignment } from "../audio/beat-alignment.ts";
import { checkGeneratedImageMatchesNarration } from "../image-qa.ts";
import { candidateWindows, extractVideoSegment, sampleVideoFrames } from "../media/video-analysis.ts";
import { FalVideoProvider } from "../providers/fal-video.ts";
import { PexelsVideoProvider, type StockVideoCandidate } from "../providers/pexels-video.ts";
import type { ImageBankContext } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { freeVisionTripped } from "../vision-route-health.ts";
import {
  scoreVisualBeatFrames,
  scoreVisualBeatImage,
  type QaImage,
  type VisualBeatQaResult,
} from "../visual-beat-qa.ts";
import {
  candidateAccepted,
  chooseVisualCandidate,
  historyEntryForBeat,
  repairVisualBeatPlan,
  selectVisualMode,
  validateVisualBeatPlan,
  weightedVisualScore,
  type ScoredCandidate,
  type VisualBeat,
  type VisualBeatPlan,
  type VisualCapabilities,
  type VisualHistoryEntry,
  type VisualMode,
} from "../visual-routing.ts";

export interface VisualBeatAssetsWorkerOptions { version?: string }

interface VoiceArtifactClip {
  scene_index: number;
  duration_sec: number;
  alignment_uri?: string;
}
interface VoiceArtifact { clips: VoiceArtifactClip[] }

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
  composition: string;
  camera_treatment: string;
  subject_placement: string;
  explanatory_pattern: string;
  image_uri?: string;
  video_uri?: string;
  preview_uri?: string;
  source_provider?: string;
  source_id?: string;
  source_url?: string;
  source_in_sec?: number;
  source_out_sec?: number;
  template_category?: "explanation";
  template_data?: string;
  semantic_match?: number;
  action_match?: number;
  visual_interest?: number;
  continuity?: number;
  generic_filler?: boolean;
  why_failure?: boolean;
  candidate_count?: number;
  /** 1-based provider-candidate rank at which the first candidate cleared the visual gate. */
  first_acceptable_candidate_index?: number;
  /** Number of stock query variants actually consumed before selection. */
  search_query_count?: number;
  /** Preferred route + at most one declared alternate. */
  mode_attempt_count?: number;
  note?: string;
}

interface ModeResult extends Partial<ResolvedBeat> {
  blobs?: BlobRef[];
  preview?: QaImage;
}

interface ReferenceCapableImageProvider {
  generatePack?: (req: {
    prompts: string[];
    aspect: "16:9";
    seed: number;
    reference?: QaImage;
    context?: ImageBankContext;
  }) => Promise<{
    images: QaImage[];
    usage?: unknown;
  }>;
}

function capabilities(): VisualCapabilities {
  return {
    stock_video: Boolean(process.env["PEXELS_API_KEY"]?.trim()),
    generated_image: true,
    motion_graphic: true,
    generated_video: Boolean(process.env["FAL_KEY"]?.trim()),
  };
}

function scored<T>(value: T, qa: VisualBeatQaResult): ScoredCandidate<T> {
  return { value, scores: qa.scores };
}

function qaFields(qa: VisualBeatQaResult): Partial<ResolvedBeat> {
  return {
    ...qa.scores,
    generic_filler: qa.generic_filler,
    why_failure: qa.why_failure,
    semantic_verified: candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure,
  };
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.floor(raw))) : fallback;
}

function promptsForBeat(beat: VisualBeat): string[] {
  const raw = beat.asset_brief.generation_variants?.length
    ? beat.asset_brief.generation_variants
    : [beat.asset_brief.generation_prompt];
  // RFC 0010 authors 3-5 concepts for a ranking pool; a cost-bounded run can
  // cap that. Never below 2 (the resolver still wants an alternative).
  return raw.filter((value) => value.trim()).slice(0, intEnv("RFC0010_MAX_IMAGE_CANDIDATES", 5, 2, 5));
}

function queriesForBeat(beat: VisualBeat): string[] {
  const raw = beat.asset_brief.query_variants?.length
    ? beat.asset_brief.query_variants
    : [beat.asset_brief.query];
  return raw.filter((value) => value.trim()).slice(0, 5);
}

function strengthenedPrompt(beat: VisualBeat, concept: string): string {
  const style = beat.routing.image_style === "illustration"
    ? "Purposeful editorial illustration with specific physical staging; never generic decorative art."
    : "Photorealistic cinematic real-world visual language unless the requested subject is inherently abstract.";
  return [
    concept,
    style,
    `VIEWER TAKEAWAY: ${beat.visual_contract.viewer_takeaway}.`,
    `MUST SHOW: ${beat.visual_contract.required.join("; ")}.`,
    beat.visual_contract.required_action ? `ACTION/STATE: ${beat.visual_contract.required_action}.` : "",
    beat.visual_contract.forbidden.length ? `EXCLUDE: ${beat.visual_contract.forbidden.join("; ")}.` : "",
    `COMPOSITION: ${beat.retention.composition}; CAMERA: ${beat.retention.camera_treatment ?? "appropriate"}; SUBJECT PLACEMENT: ${beat.retention.subject_placement ?? "appropriate"}.`,
    beat.continuity.group
      ? `CONTINUITY: group ${beat.continuity.group}; recurring entity ids ${beat.continuity.entities.join(", ") || "none"}. Preserve their physical identity.`
      : "",
    "No readable text, letters, numbers, logos, subtitles, captions, watermarks, UI or accidental typography.",
  ].filter(Boolean).join(" ");
}

function stableSeed(beatId: string, candidateIndex: number): number {
  let hash = 2166136261;
  for (const char of `${beatId}:${candidateIndex}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) & 0x7fffffff;
}

async function loadAlignedPlan(
  plan: VisualBeatPlan,
  voice: VoiceArtifact,
  ctx: WorkerContext,
): Promise<VisualBeatPlan> {
  const clips: VoiceClipForAlignment[] = [];
  for (const clip of voice.clips) {
    let alignment: unknown;
    if (clip.alignment_uri) {
      const bytes = await ctx.blobs.get(clip.alignment_uri);
      try {
        alignment = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new Error(`scene ${clip.scene_index}: invalid voice alignment JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    clips.push({ scene_index: clip.scene_index, duration_sec: clip.duration_sec, alignment });
  }
  return alignVisualBeatPlan(plan, clips, ctx.logger);
}

async function generateImage(
  beat: VisualBeat,
  ctx: WorkerContext,
  previous?: QaImage,
  continuityReference?: QaImage,
): Promise<ModeResult> {
  const provider = ctx.media.images;
  if (!provider) throw new Error("generated_image requires an image provider");
  if (provider.id.toLowerCase().includes("freellmapi")) {
    throw new Error(`RFC 0010 forbids FreeLLMAPI image generation (${provider.id})`);
  }
  const concepts = promptsForBeat(beat);
  if (concepts.length < 3) throw new Error(`${beat.id}: Visual Director supplied fewer than 3 image candidates`);
  const referenceCapable = provider as typeof provider & ReferenceCapableImageProvider;
  if (continuityReference && !referenceCapable.generatePack) {
    throw new Error(`${beat.id}: recurring continuity group requires a reference-conditioned image provider`);
  }

  const candidates: Array<{ image: QaImage; qa: VisualBeatQaResult; prompt: string }> = [];
  const unverified: QaImage[] = [];
  const failures: string[] = [];
  let firstAcceptable: number | undefined;
  for (let index = 0; index < concepts.length; index++) {
    const concept = concepts[index]!;
    try {
      const prompt = strengthenedPrompt(beat, concept);
      const bankContext = {
        graph: "visual_benchmark",
        scene_index: beat.scene_index,
        beat_id: beat.id,
        mode: "generated_image",
        narration: beat.narration,
        requirement: beat.visual_contract.required.join("; "),
        concept_index: index,
      };
      let image: QaImage | undefined;
      if (continuityReference && referenceCapable.generatePack) {
        const pack = await referenceCapable.generatePack({
          prompts: [prompt],
          aspect: "16:9",
          seed: stableSeed(beat.id, index),
          reference: continuityReference,
          context: bankContext,
        });
        image = pack.images[0];
      } else {
        const output = await provider.generate({
          prompt,
          aspect: "16:9",
          count: 1,
          tier: beat.hero_role ? "hero" : "standard",
          context: bankContext,
        });
        image = output.images[0];
      }
      if (!image) {
        failures.push("provider returned no image");
        continue;
      }
      const [contradictionQa, beatQa] = await Promise.all([
        checkGeneratedImageMatchesNarration(image, beat.narration),
        scoreVisualBeatImage(image, beat, undefined, previous ? { previous } : {}),
      ]);
      // beatQa is the primary gate: without it we cannot rank the candidate.
      // A missing contradiction check (VLM outage) is not by itself a reason to
      // discard an image the scorer accepted -- infra failures fail open.
      if (!beatQa) {
        failures.push("visual QA unavailable");
        unverified.push(image);
        // The vision route is confirmed down for this run -- generating the
        // remaining paid concepts only to not-score them is wasted fal spend.
        if (freeVisionTripped()) break;
        continue;
      }
      if (contradictionQa?.contradictsNarration) {
        failures.push(`narration contradiction: ${contradictionQa.reason}`);
        continue;
      }
      if (beatQa.generic_filler || beatQa.why_failure) {
        failures.push(`generic/irrelevant: ${beatQa.reason}`);
        continue;
      }
      if (candidateAccepted(beatQa.scores) && firstAcceptable === undefined) {
        firstAcceptable = index + 1;
      }
      candidates.push({ image, qa: beatQa, prompt: concept });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const best = chooseVisualCandidate(candidates.map((candidate) => scored(candidate, candidate.qa)));
  if (!best) {
    // Every candidate generated but the vision model could not score any of
    // them (route outage, not a quality signal). Ship the first generated
    // image unverified rather than leaving the beat with no visual; the
    // rendered-frame QA and the smoke/benchmark report classify this as a
    // QA-availability (technical) issue, never as a bad visual.
    const salvage = unverified[0];
    if (salvage && candidates.length === 0) {
      ctx.logger.warn(`[visual_beat_assets] ${beat.id}: vision QA unavailable for all ${concepts.length} generated-image candidate(s); shipping the first generated image unverified (QA_UNAVAILABLE)`);
      const ref = await ctx.blobs.put(salvage.bytes, { role: "image", media_type: salvage.media_type });
      return {
        image_uri: ref.uri,
        preview_uri: ref.uri,
        blobs: [ref],
        preview: salvage,
        candidate_count: concepts.length,
        semantic_verified: false,
        source_provider: provider.id,
        note: "QA_UNAVAILABLE: vision QA unreachable; generated image shipped unverified",
      };
    }
    throw new Error(`no generated-image candidate cleared the visual gate: ${failures.slice(0, 4).join(" | ")}`);
  }
  const chosen = best.value;
  const ref = await ctx.blobs.put(chosen.image.bytes, { role: "image", media_type: chosen.image.media_type });
  return {
    image_uri: ref.uri,
    preview_uri: ref.uri,
    blobs: [ref],
    preview: chosen.image,
    candidate_count: concepts.length,
    ...(firstAcceptable !== undefined ? { first_acceptable_candidate_index: firstAcceptable } : {}),
    source_provider: provider.id,
    ...qaFields(chosen.qa),
  };
}

interface WindowCandidate {
  source: StockVideoCandidate;
  start: number;
  end: number;
  frames: QaImage[];
  qa: VisualBeatQaResult;
}

async function resolveStockVideo(
  beat: VisualBeat,
  ctx: WorkerContext,
  previous?: QaImage,
): Promise<ModeResult> {
  const pexels = new PexelsVideoProvider();
  const queries = queriesForBeat(beat);
  if (queries.length < 3) throw new Error(`${beat.id}: Visual Director supplied fewer than 3 stock query variants`);

  // Hard budgets: without these one stock beat can sample 100+ windows
  // (queries x sources x windows), each an ffmpeg decode + a VLM call.
  const MAX_WINDOWS = intEnv("RFC0010_STOCK_MAX_WINDOWS", 36, 6, 200);
  const WINDOWS_PER_SOURCE = intEnv("RFC0010_STOCK_WINDOWS_PER_SOURCE", 3, 1, 6);

  let evaluated = 0;
  let sourceCandidateIndex = 0;
  let firstAcceptable: number | undefined;
  let qaDown = false;
  let salvage: { source: StockVideoCandidate; start: number; end: number; frames: QaImage[] } | undefined;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const sources = await pexels.search(queries[queryIndex]!, 5);
    const accepted: WindowCandidate[] = [];
    for (const source of sources) {
      sourceCandidateIndex += 1;
      let sourceAccepted = false;
      const windows = candidateWindows(source.duration_sec, beat.end_sec - beat.start_sec, WINDOWS_PER_SOURCE);
      for (const window of windows) {
        if (evaluated >= MAX_WINDOWS) break;
        evaluated += 1;
        try {
          const sampled = await sampleVideoFrames(source.bytes, window.start, window.end, 5);
          const frames: QaImage[] = sampled.map((frame) => ({ bytes: frame.bytes, media_type: frame.media_type }));
          if (!salvage) salvage = { source, start: window.start, end: window.end, frames };
          if (qaDown) break;
          const qa = await scoreVisualBeatFrames(frames, beat, previous ? { previous } : {});
          if (!qa) { qaDown = true; break; }
          if (candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure) {
            sourceAccepted = true;
            accepted.push({ source, start: window.start, end: window.end, frames, qa });
          }
        } catch (error) {
          ctx.logger.warn(`[visual_beat_assets] ${beat.id} stock window rejected: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (sourceAccepted && firstAcceptable === undefined) firstAcceptable = sourceCandidateIndex;
      if (qaDown || evaluated >= MAX_WINDOWS) break;
    }

    accepted.sort((a, b) => weightedVisualScore(b.qa.scores) - weightedVisualScore(a.qa.scores));
    const best = accepted[0];
    if (best) {
      const segment = await extractVideoSegment(best.source.bytes, best.start, best.end);
      const videoRef = await ctx.blobs.put(segment, { role: "video", media_type: "video/mp4" });
      const preview = best.frames[Math.floor(best.frames.length / 2)]!;
      const previewRef = await ctx.blobs.put(preview.bytes, { role: "image", media_type: preview.media_type });
      return {
        video_uri: videoRef.uri, preview_uri: previewRef.uri, blobs: [videoRef, previewRef], preview,
        source_provider: "pexels", source_id: best.source.id, source_url: best.source.source_url,
        source_in_sec: best.start, source_out_sec: best.end, candidate_count: evaluated,
        ...(firstAcceptable !== undefined ? { first_acceptable_candidate_index: firstAcceptable } : {}),
        search_query_count: queryIndex + 1,
        ...qaFields(best.qa),
      };
    }
    if (qaDown || evaluated >= MAX_WINDOWS) break;
  }

  if (qaDown && salvage) {
    ctx.logger.warn(`[visual_beat_assets] ${beat.id}: vision QA unreachable; shipping the first sampled Pexels window unverified (QA_UNAVAILABLE)`);
    const segment = await extractVideoSegment(salvage.source.bytes, salvage.start, salvage.end);
    const videoRef = await ctx.blobs.put(segment, { role: "video", media_type: "video/mp4" });
    const preview = salvage.frames[Math.floor(salvage.frames.length / 2)]!;
    const previewRef = await ctx.blobs.put(preview.bytes, { role: "image", media_type: preview.media_type });
    return {
      video_uri: videoRef.uri, preview_uri: previewRef.uri, blobs: [videoRef, previewRef], preview,
      source_provider: "pexels", source_id: salvage.source.id, source_url: salvage.source.source_url,
      source_in_sec: salvage.start, source_out_sec: salvage.end, candidate_count: evaluated,
      semantic_verified: false,
      note: "QA_UNAVAILABLE: vision QA unreachable; stock window shipped unverified",
    };
  }

  throw new Error(`no Pexels candidate/window cleared the visual gate after ${evaluated} actual windows across ${queries.length} queries`);
}

function motionGraphic(beat: VisualBeat): ModeResult {
  const brief = beat.asset_brief.motion_graphic_brief.trim();
  if (!brief) throw new Error(`${beat.id}: motion_graphic route has no deterministic brief`);
  const pattern = beat.retention.explanatory_pattern ?? "reveal";
  const mapping: Record<string, { representationMode: string; sceneBlueprint: string }> = {
    map: { representationMode: "spatial", sceneBlueprint: "map" },
    timeline: { representationMode: "temporal", sceneBlueprint: "timeline" },
    comparison: { representationMode: "quantitative", sceneBlueprint: "scale-comparison" },
    counter: { representationMode: "quantitative", sceneBlueprint: "scale-comparison" },
    process: { representationMode: "domain-model", sceneBlueprint: "flow-system" },
    cause_effect: { representationMode: "domain-model", sceneBlueprint: "flow-system" },
  };
  const semantic = mapping[pattern] ?? { representationMode: "kinetic-text", sceneBlueprint: "animated-statement" };
  return {
    template_category: "explanation",
    template_data: JSON.stringify({
      ...semantic,
      visualClaim: beat.visual_contract.viewer_takeaway,
      keyText: beat.visual_contract.viewer_takeaway,
      elements: beat.visual_contract.required,
      semanticEntities: beat.continuity.entities.map((entity_id, index) => ({
        entity_id,
        label: beat.visual_contract.required[index] ?? entity_id,
        depiction: {
          kind: "concept",
          appearance: beat.visual_contract.required[index] ?? entity_id,
          color: "neutral",
        },
      })),
      semanticActionWindows: beat.visual_contract.required_action
        ? [{
          actor: beat.continuity.entities[0] ?? "subject",
          action: beat.visual_contract.required_action,
          target: beat.continuity.entities[1] ?? "state",
          startRatio: 0.15,
          endRatio: 0.85,
          aligned: true,
        }]
        : [],
      rfc0010Brief: brief,
    }),
    semantic_verified: false,
    candidate_count: 1,
    first_acceptable_candidate_index: 1,
  };
}

async function generateVideo(
  beat: VisualBeat,
  ctx: WorkerContext,
  previous?: QaImage,
): Promise<ModeResult> {
  if (!beat.hero_role && beat.intent.importance < 0.85) {
    throw new Error(`${beat.id}: generated video is reserved for hero/high-value beats`);
  }
  const provider = new FalVideoProvider();
  const concepts = promptsForBeat(beat).slice(0, 3);
  const motion = beat.asset_brief.generated_video_prompt?.trim() || beat.asset_brief.generation_prompt;
  const accepted: Array<{ bytes: Uint8Array; frames: QaImage[]; qa: VisualBeatQaResult; model: string; duration: number }> = [];
  let firstAcceptable: number | undefined;
  let salvage: { bytes: Uint8Array; frames: QaImage[]; model: string; duration: number } | undefined;

  for (let index = 0; index < concepts.length; index++) {
    const concept = concepts[index]!;
    try {
      const generated = await provider.generate(`${concept}. MOTION: ${motion}`, beat.end_sec - beat.start_sec);
      const sampled = await sampleVideoFrames(generated.bytes, 0, generated.duration_sec, 5);
      const frames: QaImage[] = sampled.map((frame) => ({ bytes: frame.bytes, media_type: frame.media_type }));
      if (!salvage) salvage = { bytes: generated.bytes, frames, model: generated.model, duration: generated.duration_sec };
      const qa = await scoreVisualBeatFrames(frames, beat, previous ? { previous } : {});
      if (!qa) {
        // premium text-to-video is the most expensive candidate -- do not keep
        // generating it just to not-score it.
        if (freeVisionTripped()) break;
        continue;
      }
      if (candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure) {
        if (firstAcceptable === undefined) firstAcceptable = index + 1;
        accepted.push({ bytes: generated.bytes, frames, qa, model: generated.model, duration: generated.duration_sec });
      }
    } catch (error) {
      ctx.logger.warn(`[visual_beat_assets] ${beat.id} generated-video candidate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  accepted.sort((a, b) => weightedVisualScore(b.qa.scores) - weightedVisualScore(a.qa.scores));
  const best = accepted[0];
  if (!best) {
    if (salvage && freeVisionTripped()) {
      ctx.logger.warn(`[visual_beat_assets] ${beat.id}: vision QA unreachable; shipping the first generated video unverified (QA_UNAVAILABLE)`);
      const wantedS = Math.min(salvage.duration, beat.end_sec - beat.start_sec);
      const seg = wantedS < salvage.duration ? await extractVideoSegment(salvage.bytes, 0, wantedS) : salvage.bytes;
      const vRef = await ctx.blobs.put(seg, { role: "video", media_type: "video/mp4" });
      const prev = salvage.frames[Math.floor(salvage.frames.length / 2)]!;
      const pRef = await ctx.blobs.put(prev.bytes, { role: "image", media_type: prev.media_type });
      return {
        video_uri: vRef.uri, preview_uri: pRef.uri, blobs: [vRef, pRef], preview: prev,
        source_provider: "fal", source_id: salvage.model, source_in_sec: 0, source_out_sec: wantedS,
        candidate_count: concepts.length, semantic_verified: false,
        note: "QA_UNAVAILABLE: vision QA unreachable; generated video shipped unverified",
      };
    }
    throw new Error(`no generated-video candidate cleared the visual gate (${concepts.length} attempted)`);
  }
  const wanted = Math.min(best.duration, beat.end_sec - beat.start_sec);
  const segment = wanted < best.duration ? await extractVideoSegment(best.bytes, 0, wanted) : best.bytes;
  const videoRef = await ctx.blobs.put(segment, { role: "video", media_type: "video/mp4" });
  const preview = best.frames[Math.floor(best.frames.length / 2)]!;
  const previewRef = await ctx.blobs.put(preview.bytes, { role: "image", media_type: preview.media_type });
  return {
    video_uri: videoRef.uri,
    preview_uri: previewRef.uri,
    blobs: [videoRef, previewRef],
    preview,
    source_provider: "fal",
    source_id: best.model,
    source_in_sec: 0,
    source_out_sec: wanted,
    candidate_count: concepts.length,
    ...(firstAcceptable !== undefined ? { first_acceptable_candidate_index: firstAcceptable } : {}),
    ...qaFields(best.qa),
  };
}

async function resolveMode(
  beat: VisualBeat,
  mode: VisualMode,
  ctx: WorkerContext,
  previous?: QaImage,
  continuityReference?: QaImage,
): Promise<ModeResult> {
  switch (mode) {
    case "generated_image": return generateImage(beat, ctx, previous, continuityReference);
    case "stock_video": return resolveStockVideo(beat, ctx, previous);
    case "generated_video": return generateVideo(beat, ctx, previous);
    case "motion_graphic": return motionGraphic(beat);
  }
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
    version: opts.version ?? "5",
    consumes: [
      { schema_id: "visual_beat_plan", range: "^1", as: "plan" },
      { schema_id: "voice", range: "^1", as: "voice" },
    ],
    produces: "visual_beat_assets",
    produces_version: "1.1.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const rawPlan = inputs["plan"]!.payload as VisualBeatPlan;
      const { plan: provisional, repairs } = repairVisualBeatPlan(rawPlan);
      for (const repair of repairs) ctx.logger.warn(`[visual_beat_assets] routing repair: ${repair}`);
      const validation = validateVisualBeatPlan(provisional);
      if (validation.length) throw new Error(`visual beat plan invariant failed: ${validation.join("; ")}`);
      const aligned = await loadAlignedPlan(provisional, inputs["voice"]!.payload as VoiceArtifact, ctx);
      const ordered = [...aligned.beats].sort((a, b) => a.scene_index - b.scene_index || a.beat_index - b.beat_index);
      const history: VisualHistoryEntry[] = [];
      const blobs: BlobRef[] = [];
      const beats: ResolvedBeat[] = [];
      const continuityReferences = new Map<string, QaImage>();
      let previousPreview: QaImage | undefined;
      const available = capabilities();

      for (const beat of ordered) {
        const requested = beat.routing.preferred;
        let selected = selectVisualMode(beat, history, available);
        let result: ModeResult | null = null;
        let note = "";
        let modeAttemptCount = 0;
        const continuityReference = beat.continuity.group
          ? continuityReferences.get(beat.continuity.group)
          : undefined;

        if (selected) {
          try {
            modeAttemptCount += 1;
            result = await resolveMode(beat, selected, ctx, previousPreview, continuityReference);
          } catch (error) {
            note = error instanceof Error ? error.message : String(error);
            const alternate = alternateMode(beat, selected);
            if (alternate && available[alternate]) {
              try {
                selected = alternate;
                modeAttemptCount += 1;
                result = await resolveMode(beat, selected, ctx, previousPreview, continuityReference);
                note = `primary route failed; used declared alternate: ${note}`;
              } catch (fallbackError) {
                note = `${note}; alternate failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
                selected = null;
              }
            } else {
              selected = null;
            }
          }
        } else {
          note = "neither agent-declared mode is available";
        }

        if (result?.blobs) blobs.push(...result.blobs);
        if (result?.preview) {
          previousPreview = result.preview;
          if (beat.continuity.group && beat.continuity.entities.length > 0) {
            continuityReferences.set(beat.continuity.group, result.preview);
          }
        }
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
          composition: beat.retention.composition,
          camera_treatment: beat.retention.camera_treatment ?? "unknown",
          subject_placement: beat.retention.subject_placement ?? "unknown",
          explanatory_pattern: beat.retention.explanatory_pattern ?? "unknown",
          ...(result?.image_uri ? { image_uri: result.image_uri } : {}),
          ...(result?.video_uri ? { video_uri: result.video_uri } : {}),
          ...(result?.preview_uri ? { preview_uri: result.preview_uri } : {}),
          ...(result?.source_provider ? { source_provider: result.source_provider } : {}),
          ...(result?.source_id ? { source_id: result.source_id } : {}),
          ...(result?.source_url ? { source_url: result.source_url } : {}),
          ...(result?.source_in_sec !== undefined ? { source_in_sec: result.source_in_sec } : {}),
          ...(result?.source_out_sec !== undefined ? { source_out_sec: result.source_out_sec } : {}),
          ...(result?.template_category ? { template_category: result.template_category } : {}),
          ...(result?.template_data ? { template_data: result.template_data } : {}),
          ...(result?.semantic_match !== undefined ? { semantic_match: result.semantic_match } : {}),
          ...(result?.action_match !== undefined ? { action_match: result.action_match } : {}),
          ...(result?.visual_interest !== undefined ? { visual_interest: result.visual_interest } : {}),
          ...(result?.continuity !== undefined ? { continuity: result.continuity } : {}),
          ...(result?.generic_filler !== undefined ? { generic_filler: result.generic_filler } : {}),
          ...(result?.why_failure !== undefined ? { why_failure: result.why_failure } : {}),
          ...(result?.candidate_count !== undefined ? { candidate_count: result.candidate_count } : {}),
          ...(result?.first_acceptable_candidate_index !== undefined
            ? { first_acceptable_candidate_index: result.first_acceptable_candidate_index }
            : {}),
          ...(result?.search_query_count !== undefined ? { search_query_count: result.search_query_count } : {}),
          mode_attempt_count: modeAttemptCount,
          ...(note ? { note } : {}),
        };
        if (selected) history.push(historyEntryForBeat(beat, selected, beat.end_sec - beat.start_sec));
        beats.push(resolved);
      }

      const summary = {
        resolved: beats.filter((beat) => beat.status === "resolved").length,
        fallbacks: beats.filter((beat) => beat.status === "fallback").length,
        unavailable: beats.filter((beat) => beat.status === "unavailable").length,
        stock_videos: beats.filter((beat) => beat.resolved_mode === "stock_video").length,
        generated_images: beats.filter((beat) => beat.resolved_mode === "generated_image").length,
        motion_graphics: beats.filter((beat) => beat.resolved_mode === "motion_graphic").length,
        generated_videos: beats.filter((beat) => beat.resolved_mode === "generated_video").length,
        generic_filler: beats.filter((beat) => beat.generic_filler).length,
        why_failures: beats.filter((beat) => beat.why_failure).length,
      };
      return { payload: { beats, summary }, blobs };
    },
  };
}
