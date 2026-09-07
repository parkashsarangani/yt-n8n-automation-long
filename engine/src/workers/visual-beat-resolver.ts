import type { BlobRef } from "../artifact.ts";
import { alignVisualBeatPlan, type VoiceClipForAlignment } from "../audio/beat-alignment.ts";
import { checkGeneratedImageMatchesNarration } from "../image-qa.ts";
import { candidateWindows, extractVideoSegment, sampleVideoFrames } from "../media/video-analysis.ts";
import { FalVideoProvider } from "../providers/fal-video.ts";
import { PexelsVideoProvider, type StockVideoCandidate } from "../providers/pexels-video.ts";
import type { ImageBankContext } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import {
  kineticPhraseScene,
  semanticSceneRequirements,
  threadSemanticSequence,
  validateSemanticScene,
  type SemanticScene,
} from "../semantic-scene.ts";
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
  type VisualRepresentation,
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
  /** What the pixels are, not just which provider made them. */
  representation?: VisualRepresentation;
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

interface VisionQaRunHealth {
  unavailable: boolean;
  reason?: string;
}

function markVisionQaUnavailable(health: VisionQaRunHealth, reason: string): void {
  if (!health.unavailable) health.reason = reason;
  health.unavailable = true;
}

function qaUnavailableError(health: VisionQaRunHealth, beatId: string): Error {
  const suffix = health.reason ? ` (${health.reason})` : "";
  return new Error(`QA_UNAVAILABLE: ${beatId}: vision QA is unavailable for this resolver run${suffix}`);
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

/** First non-empty identity description for a continuity group wins for the run. */
export function continuityIdentity(beat: VisualBeat, pinned: Map<string, string>): string {
  const group = beat.continuity.group?.trim();
  if (!group) return "";
  const established = pinned.get(group);
  if (established) return established;
  const own = beat.continuity.identity?.trim();
  if (own) pinned.set(group, own);
  return own ?? "";
}

const NO_PSEUDO_TEXT =
  "Any paper, screen, sign, label or document in frame must be BLANK, turned away, or far enough from the camera that no individual letterform is resolvable. Never render simulated handwriting, invented lettering, fake interface text, watermarks, subtitles or captions.";

const RESTRAINED_METAPHOR =
  "Keep the real-world scene dominant. Any symbolic signal, trail, arrow, pulse or highlight must be small, subtle and secondary to the physical action. No energy beams, explosions, portals, lens flares, sci-fi holograms or glowing overlays that take over the frame. Everyday objects stay ordinary size and plausibly framed.";

function strengthenedPrompt(beat: VisualBeat, concept: string, identity = ""): string {
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
      ? `CONTINUITY: group ${beat.continuity.group}; recurring entity ids ${beat.continuity.entities.join(", ") || "none"}. Preserve their physical identity exactly.`
      : "",
    identity ? `THE RECURRING SUBJECT IS ALWAYS: ${identity}. Do not change age, build, hair, clothing, carried items or distinguishing attributes.` : "",
    NO_PSEUDO_TEXT,
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
  health: VisionQaRunHealth,
  previous?: QaImage,
  continuityReference?: QaImage,
  identity = "",
): Promise<ModeResult> {
  if (health.unavailable) throw qaUnavailableError(health, beat.id);
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
  let attemptedCandidates = 0;

  // Reusable image bank: an image generated for a semantically similar beat in
  // any earlier run/episode can satisfy this one for free. Retrieval only
  // proposes; the same multimodal gate below decides. A reused image that
  // clears the gate skips fal entirely.
  const bank = provider as typeof provider & {
    searchByContext?: (q: { requirement?: string; narration?: string; mode?: string }, limit?: number) => Promise<Array<{ bytes: Uint8Array; media_type: string; score: number }>>;
    reuseCount?: number;
  };
  if (!continuityReference && typeof bank.searchByContext === "function") {
    const found = await bank.searchByContext(
      { requirement: beat.visual_contract.required.join("; "), narration: beat.narration, mode: "generated_image" },
      4,
    );
    for (const match of found) {
      const image: QaImage = { bytes: match.bytes, media_type: match.media_type };
      const qa = await scoreVisualBeatImage(image, beat, undefined, previous ? { previous } : {});
      if (qa && candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure) {
        if (bank.reuseCount !== undefined) bank.reuseCount += 1;
        ctx.logger.warn(`[visual_beat_assets] ${beat.id}: reused a bank image (match ${match.score.toFixed(2)}), no fal spend`);
        const ref = await ctx.blobs.put(image.bytes, { role: "image", media_type: image.media_type });
        return {
          image_uri: ref.uri, preview_uri: ref.uri, blobs: [ref], preview: image,
          candidate_count: 0, source_provider: "image-bank", note: "reused from image bank",
          ...qaFields(qa),
        };
      }
      if (!qa) {
        unverified.push(image);
        markVisionQaUnavailable(health, `${beat.id}: image-bank candidate could not be scored`);
        break;
      }
    }
  }

  if (health.unavailable && unverified.length > 0) {
    const salvage = unverified[0]!;
    ctx.logger.warn(`[visual_beat_assets] ${beat.id}: vision QA unavailable while validating the image bank; reusing the first tagged image unverified and skipping fal spend (QA_UNAVAILABLE)`);
    const ref = await ctx.blobs.put(salvage.bytes, { role: "image", media_type: salvage.media_type });
    return {
      image_uri: ref.uri, preview_uri: ref.uri, blobs: [ref], preview: salvage,
      candidate_count: 0, semantic_verified: false, source_provider: "image-bank",
      note: "QA_UNAVAILABLE: vision QA unreachable; image-bank candidate shipped unverified",
    };
  }

  for (let index = 0; index < concepts.length; index++) {
    if (health.unavailable) break;
    const concept = concepts[index]!;
    try {
      const prompt = strengthenedPrompt(beat, concept, identity);
      attemptedCandidates += 1;
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
        markVisionQaUnavailable(health, `${beat.id}: generated-image candidate could not be scored`);
        break;
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
        candidate_count: attemptedCandidates,
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
    candidate_count: attemptedCandidates,
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
  health: VisionQaRunHealth,
  previous?: QaImage,
): Promise<ModeResult> {
  if (health.unavailable) throw qaUnavailableError(health, beat.id);
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
          if (!qa) {
            qaDown = true;
            markVisionQaUnavailable(health, `${beat.id}: stock-video window could not be scored`);
            break;
          }
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

/**
 * Decide what a motion-graphic beat is actually going to draw.
 *
 * The old implementation mapped `explanatory_pattern` onto one of eleven
 * generic scene blueprints and handed the renderer a prose brief plus
 * `{kind:"concept"}` entities. Whatever the beat said, `scale-comparison`
 * drew a dot-grid box beside an empty box and `flow-system` drew four wavy
 * dashes; four consecutive beats rendered byte-identically and the whole set
 * scored 0.05-0.28 semantic match with 0.60 generic filler. The brief itself
 * ("draw one labelled distance-versus-time scale with a common origin") never
 * reached a single pixel.
 *
 * Now there is exactly one question: did the Visual Director supply a
 * `semantic_scene` that can be drawn literally? If yes, that structure is what
 * renders. If no, the beat becomes kinetic text derived from its own copy —
 * an honest, legible fallback — and says so. There is deliberately no third
 * option that invents plausible-looking geometry.
 */
export function resolveSemanticScene(
  beat: VisualBeat,
  threaded: SemanticScene | undefined,
): { scene: SemanticScene; representation: VisualRepresentation; note?: string } {
  if (!threaded || threaded.kind === "kinetic_phrase") {
    const reason = threaded ? "director chose kinetic text" : "no semantic_scene authored";
    return {
      scene: threaded ?? kineticPhraseScene(beat.visual_contract.viewer_takeaway || beat.narration),
      representation: "kinetic_text",
      ...(threaded ? {} : { note: `SEMANTIC_FALLBACK: ${reason}; rendered as kinetic text` }),
    };
  }
  const errors = validateSemanticScene(threaded, beat.id);
  if (errors.length) {
    return {
      scene: kineticPhraseScene(beat.visual_contract.viewer_takeaway || beat.narration, threaded.sequence_id),
      representation: "kinetic_text",
      note: `SEMANTIC_FALLBACK: semantic_scene is not drawable (${errors.slice(0, 2).join("; ")}); rendered as kinetic text`,
    };
  }
  return { scene: threaded, representation: "semantic_graphic" };
}

function motionGraphic(beat: VisualBeat, threaded: SemanticScene | undefined): ModeResult {
  const { scene, representation, note } = resolveSemanticScene(beat, threaded);
  // The renderer runs a pixel gate on the composed scene (render-bridge's
  // reviewSemanticMotion). When a graphic fails it there, it must have
  // something honest to fall back to WITHOUT a second engine round trip, so
  // the kinetic-phrase form of this same beat travels with it. Deriving it
  // here also keeps phrase extraction in one place, under unit test.
  const fallback = scene.kind === "kinetic_phrase"
    ? scene
    : kineticPhraseScene(beat.visual_contract.viewer_takeaway || beat.narration, scene.sequence_id);
  return {
    template_category: "explanation",
    template_data: JSON.stringify({
      // The ONLY payload the rfc0010 renderer reads. Deliberately no
      // representationMode/sceneBlueprint: those are what route a beat into
      // the generic blueprint registry this replaces.
      rfc0010SemanticScene: scene,
      rfc0010FallbackScene: fallback,
      rfc0010Requirements: semanticSceneRequirements(scene),
      keyText: scene.caption,
      narration: beat.narration,
    }),
    representation,
    semantic_verified: false,
    candidate_count: 1,
    first_acceptable_candidate_index: 1,
    ...(note ? { note } : {}),
  };
}

async function generateVideo(
  beat: VisualBeat,
  ctx: WorkerContext,
  health: VisionQaRunHealth,
  previous?: QaImage,
  identity = "",
): Promise<ModeResult> {
  if (health.unavailable) throw qaUnavailableError(health, beat.id);
  if (!beat.hero_role && beat.intent.importance < 0.85) {
    throw new Error(`${beat.id}: generated video is reserved for hero/high-value beats`);
  }
  const provider = new FalVideoProvider();
  const concepts = promptsForBeat(beat).slice(0, 3);
  const motion = beat.asset_brief.generated_video_prompt?.trim() || beat.asset_brief.generation_prompt;
  const accepted: Array<{ bytes: Uint8Array; frames: QaImage[]; qa: VisualBeatQaResult; model: string; duration: number }> = [];
  let firstAcceptable: number | undefined;
  let attemptedCandidates = 0;
  let salvage: { bytes: Uint8Array; frames: QaImage[]; model: string; duration: number } | undefined;

  for (let index = 0; index < concepts.length; index++) {
    if (health.unavailable) break;
    const concept = concepts[index]!;
    try {
      attemptedCandidates += 1;
      const identityClause = identity
        ? `THE RECURRING SUBJECT IS ALWAYS: ${identity}. Keep age, build, hair, clothing, carried items and distinguishing attributes identical to earlier shots.`
        : "";
      const generated = await provider.generate(
        `${concept}. MOTION: ${motion}. ${identityClause} ${RESTRAINED_METAPHOR} ${NO_PSEUDO_TEXT}`.trim(),
        beat.end_sec - beat.start_sec,
      );
      const sampled = await sampleVideoFrames(generated.bytes, 0, generated.duration_sec, 5);
      const frames: QaImage[] = sampled.map((frame) => ({ bytes: frame.bytes, media_type: frame.media_type }));
      if (!salvage) salvage = { bytes: generated.bytes, frames, model: generated.model, duration: generated.duration_sec };
      const qa = await scoreVisualBeatFrames(frames, beat, previous ? { previous } : {});
      if (!qa) {
        markVisionQaUnavailable(health, `${beat.id}: generated-video candidate could not be scored`);
        break;
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
    if (salvage && health.unavailable) {
      ctx.logger.warn(`[visual_beat_assets] ${beat.id}: vision QA unreachable; shipping the first generated video unverified (QA_UNAVAILABLE)`);
      const wantedS = Math.min(salvage.duration, beat.end_sec - beat.start_sec);
      const seg = wantedS < salvage.duration ? await extractVideoSegment(salvage.bytes, 0, wantedS) : salvage.bytes;
      const vRef = await ctx.blobs.put(seg, { role: "video", media_type: "video/mp4" });
      const prev = salvage.frames[Math.floor(salvage.frames.length / 2)]!;
      const pRef = await ctx.blobs.put(prev.bytes, { role: "image", media_type: prev.media_type });
      return {
        video_uri: vRef.uri, preview_uri: pRef.uri, blobs: [vRef, pRef], preview: prev,
        source_provider: "fal", source_id: salvage.model, source_in_sec: 0, source_out_sec: wantedS,
        candidate_count: attemptedCandidates, semantic_verified: false,
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
    candidate_count: attemptedCandidates,
    ...(firstAcceptable !== undefined ? { first_acceptable_candidate_index: firstAcceptable } : {}),
    ...qaFields(best.qa),
  };
}

async function resolveMode(
  beat: VisualBeat,
  mode: VisualMode,
  ctx: WorkerContext,
  health: VisionQaRunHealth,
  previous?: QaImage,
  continuityReference?: QaImage,
  semanticScene?: SemanticScene,
  identity = "",
): Promise<ModeResult> {
  switch (mode) {
    case "generated_image": return { representation: "generated_image", ...await generateImage(beat, ctx, health, previous, continuityReference, identity) };
    case "stock_video": return { representation: "stock_video", ...await resolveStockVideo(beat, ctx, health, previous) };
    case "generated_video": return { representation: "generated_video", ...await generateVideo(beat, ctx, health, previous, identity) };
    case "motion_graphic": return motionGraphic(beat, semanticScene);
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
    produces_version: "1.2.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const rawPlan = inputs["plan"]!.payload as VisualBeatPlan;
      const { plan: provisional, repairs } = repairVisualBeatPlan(rawPlan);
      for (const repair of repairs) ctx.logger.warn(`[visual_beat_assets] routing repair: ${repair}`);
      const validation = validateVisualBeatPlan(provisional);
      if (validation.length) throw new Error(`visual beat plan invariant failed: ${validation.join("; ")}`);
      const aligned = await loadAlignedPlan(provisional, inputs["voice"]!.payload as VoiceArtifact, ctx);
      const ordered = [...aligned.beats].sort((a, b) => a.scene_index - b.scene_index || a.beat_index - b.beat_index);

      // Explanatory sequence state is threaded across the WHOLE plan before any
      // beat resolves, because a continuation beat's scene depends on what an
      // earlier beat established -- the shared 20 km scale that the walking
      // result and then the message both have to travel along. Doing this
      // per-beat inside the loop is what made three cumulative beats render as
      // three unrelated resets.
      const threadedScenes = new Map<string, SemanticScene>();
      {
        const carriers = ordered.filter((beat) => beat.asset_brief.semantic_scene);
        const threaded = threadSemanticSequence(carriers.map((beat) => beat.asset_brief.semantic_scene!));
        carriers.forEach((beat, index) => threadedScenes.set(beat.id, threaded[index]!));
      }

      const history: VisualHistoryEntry[] = [];
      const blobs: BlobRef[] = [];
      const beats: ResolvedBeat[] = [];
      const continuityReferences = new Map<string, QaImage>();
      const pinnedIdentity = new Map<string, string>();
      const qaHealth: VisionQaRunHealth = { unavailable: false };
      let previousPreview: QaImage | undefined;
      const available = capabilities();

      for (const plannedBeat of ordered) {
        const identity = continuityIdentity(plannedBeat, pinnedIdentity);
        const beat: VisualBeat = identity && plannedBeat.continuity.identity !== identity
          ? { ...plannedBeat, continuity: { ...plannedBeat.continuity, identity } }
          : plannedBeat;
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
            result = await resolveMode(beat, selected, ctx, qaHealth, previousPreview, continuityReference, threadedScenes.get(beat.id), identity);
          } catch (error) {
            note = error instanceof Error ? error.message : String(error);
            const alternate = alternateMode(beat, selected);
            if (alternate && available[alternate]) {
              try {
                selected = alternate;
                modeAttemptCount += 1;
                result = await resolveMode(beat, selected, ctx, qaHealth, previousPreview, continuityReference, threadedScenes.get(beat.id), identity);
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

        // A mode can report its own diagnostic (a semantic scene that had to
        // fall back to kinetic text, a QA_UNAVAILABLE degrade-accept). Keep it
        // alongside any routing note rather than letting one silently win.
        if (result?.note) note = note ? `${note}; ${result.note}` : result.note;
        if (result?.blobs) blobs.push(...result.blobs);
        if (result?.preview) {
          previousPreview = result.preview;
          if (
            beat.continuity.group &&
            beat.continuity.entities.length > 0 &&
            (selected === "generated_image" || selected === "generated_video")
          ) {
            // Never let anonymous stock or a diagram become the visual identity
            // reference for a recurring person/object.
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
          ...(result?.representation ? { representation: result.representation } : {}),
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
        // Representation counts, separate from provider mode: a run where every
        // motion-graphic beat degraded to kinetic text is a very different
        // result from one where they rendered real diagrams, and the mode
        // counters alone cannot tell those apart.
        semantic_graphics: beats.filter((beat) => beat.representation === "semantic_graphic").length,
        kinetic_texts: beats.filter((beat) => beat.representation === "kinetic_text").length,
      };
      return { payload: { beats, summary }, blobs };
    },
  };
}
