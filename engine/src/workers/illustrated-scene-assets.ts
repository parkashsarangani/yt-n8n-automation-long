/**
 * RFC 0009 illustrated asset worker.
 * Direction@2 supplies 1-3 visual shots per narration scene. Hero shots use
 * best-of-three generation. The ordered sequence receives one compact visual
 * review + targeted regeneration. QA retries reuse every unchanged successful
 * shot pack instead of re-rolling the whole episode.
 */
import type { Artifact, BlobRef } from "../artifact.ts";
import { checkGeneratedImageForText, checkGeneratedImageMatchesNarration, rankHeroImageCandidates, reviewIllustratedSequence, type VisualSequenceEntry, type VisualSequenceReviewResult } from "../image-qa.ts";
import type { Aspect, ImageProvider } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

type CameraMove = "push-in" | "pull-out" | "pan-left" | "pan-right" | "hold";
type ShotFunction = "wide" | "medium" | "close-up" | "object-detail" | "reaction" | "environmental-consequence" | "reveal" | "scale-shot" | "point-of-view" | "silhouette" | "location-before-after";
type HeroRole = "hook" | "first-escalation" | "low-point" | "turn" | "payoff";
type ImageStyle = "ink_wash_stickman" | "flat_comic_expressive" | "documentary_sketch" | "watercolor_storybook" | "noir_charcoal";
interface DirectionShot { shot_index: number; image_prompt: string; camera_move: CameraMove; shot_function: ShotFunction; importance: "normal" | "hero"; hero_role?: HeroRole }
interface DirectionScene { scene_index: number; on_screen_label?: string; shots: DirectionShot[] }
interface ScriptScene { scene_index: number; narration?: string; is_outro?: boolean }
interface IntentPayload { image_style?: ImageStyle }
interface GeneratedImage { bytes: Uint8Array; media_type: string }
interface PriorScene { scene_index?: number; source?: "primary" | "fallback" | "placeholder"; image_uri?: string; image_uris?: string[]; prompt?: string }
interface ReferenceCapableProvider extends ImageProvider { generatePack?: (req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) => Promise<{ images: GeneratedImage[] }> }
export interface IllustratedSceneAssetsWorkerOptions { version?: string }

const DEFAULT_STYLE: ImageStyle = "ink_wash_stickman";
const STYLE_BUNDLES: Record<ImageStyle, { positive: string; negative: string }> = {
  ink_wash_stickman: { positive: "hand-drawn pen-and-ink illustration, muted sepia/ochre/dusty-green wash, faceless minimal human figures, detailed environments/objects/animals, visible paper grain, wide off-centre composition with real negative space", negative: "photorealistic humans, glossy 3D, lens flare, dramatic rim light, centered symmetrical hero pose, readable text, letters, numbers, logos, watermark" },
  flat_comic_expressive: { positive: "flat 2D comic illustration, bold black outlines, limited bright palette, simplified geometric people with minimal expressive faces, clean flat shapes, off-centre composition and negative space", negative: "photorealism, glossy 3D, airbrushed shading, muted gray palette, centered symmetrical pose, readable text, letters, numbers, logos, watermark" },
  documentary_sketch: { positive: "restrained charcoal and graphite reportage sketch, realistic proportions rendered as drawing, observational setting detail, muted grayscale with at most one restrained accent, paper tooth and cross-hatching", negative: "photorealistic render, smooth skin, glossy 3D, bright saturation, cartoon proportions, readable text, letters, numbers, logos, watermark" },
  watercolor_storybook: { positive: "soft watercolor storybook illustration, visible brushwork and color bleed, simplified painterly figures, warm pastel palette, breathing off-centre composition, paper texture", negative: "photorealism, glossy 3D, hard neon lighting, vector-flat plastic look, readable text, letters, numbers, logos, watermark" },
  noir_charcoal: { positive: "high-contrast charcoal and ink illustration, heavy chiaroscuro, expressive rough marks, restrained monochrome palette, cinematic negative space, visibly hand-drawn texture", negative: "photorealism, glossy 3D, bright candy colors, clean corporate vector style, readable text, letters, numbers, logos, watermark" },
};
function clean(value: unknown, max: number): string { return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : ""; }
export function buildIllustratedPrompt(subject: string, style: ImageStyle = DEFAULT_STYLE): string {
  const bundle = STYLE_BUNDLES[style] ?? STYLE_BUNDLES[DEFAULT_STYLE];
  return `${clean(subject, 500)}. VISUAL IDENTITY: ${bundle.positive}. EXCLUDE: ${bundle.negative}. No typography.`;
}

/** Hard deterministic enforcement for RFC 0009 Decisions 3-5. */
export function validateEpisodeDirection(direction: { scenes: DirectionScene[]; hero_shots: string[] }, scriptSceneIndices: number[]): void {
  const errors: string[] = [], scriptSet = new Set(scriptSceneIndices), declared = direction.hero_shots;
  if (new Set(declared).size !== declared.length) errors.push("hero_shots contains duplicates");
  if (declared.length < 3 || declared.length > 5) errors.push(`hero_shots has ${declared.length}; requires 3-5`);
  const actualHeroes: string[] = [], flatFunctions: ShotFunction[] = [], seenScenes = new Set<number>();
  for (const scene of [...direction.scenes].sort((a, b) => a.scene_index - b.scene_index)) {
    if (seenScenes.has(scene.scene_index)) errors.push(`scene ${scene.scene_index} is duplicated`); seenScenes.add(scene.scene_index);
    if (!scriptSet.has(scene.scene_index)) errors.push(`direction scene ${scene.scene_index} has no script scene`);
    const seenShot = new Set<number>();
    [...scene.shots].sort((a, b) => a.shot_index - b.shot_index).forEach((shot, position) => {
      if (seenShot.has(shot.shot_index)) errors.push(`scene ${scene.scene_index} repeats shot_index ${shot.shot_index}`); seenShot.add(shot.shot_index);
      if (shot.shot_index !== position) errors.push(`scene ${scene.scene_index} shot indices must be contiguous from 0`);
      const id = `${scene.scene_index}:${shot.shot_index}`;
      if (shot.importance === "hero") actualHeroes.push(id);
      if (shot.importance === "hero" && !shot.hero_role) errors.push(`hero shot ${id} has no hero_role`);
      if (shot.importance === "normal" && shot.hero_role) errors.push(`normal shot ${id} carries hero_role`);
      flatFunctions.push(shot.shot_function);
    });
  }
  for (const idx of scriptSet) if (!seenScenes.has(idx)) errors.push(`script scene ${idx} has no direction scene`);
  const ds = [...declared].sort(), as = [...actualHeroes].sort();
  if (JSON.stringify(ds) !== JSON.stringify(as)) errors.push(`hero_shots does not match shots marked hero (declared=${ds.join(",")}; actual=${as.join(",")})`);
  for (let i = 2; i < flatFunctions.length; i++) if (flatFunctions[i] === flatFunctions[i - 1] && flatFunctions[i] === flatFunctions[i - 2]) errors.push(`three consecutive shots use ${flatFunctions[i]}`);
  if (errors.length) throw new Error(`episode direction invariant failed: ${errors.join("; ")}`);
}

function stableSeed(value: string): number { let h = 2166136261; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) & 0x7fffffff; }
async function generateOne(provider: ReferenceCapableProvider, prompt: string, seed: number, budget: ImageBudget, reference?: GeneratedImage): Promise<GeneratedImage> {
  budget.chargeProviderCall();
  if (provider.generatePack) { const out = await provider.generatePack({ prompts: [prompt], aspect: "16:9", seed, ...(reference ? { reference } : {}) }); const image = out.images[0]; if (!image) throw new Error("image provider returned no image"); return image; }
  const out = await provider.generate({ prompt, aspect: "16:9", count: 1 }); const image = out.images[0]; if (!image) throw new Error("image provider returned no image"); return image;
}
const MAX_ATTEMPTS_PER_ACCEPTED_IMAGE = 2;
async function generateAccepted(provider: ReferenceCapableProvider, prompt: string, seed: number, reference: GeneratedImage | undefined, narration: string, logger: WorkerContext["logger"], shotId: string, budget: ImageBudget): Promise<GeneratedImage> {
  let lastError = new Error("image generation failed");
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCEPTED_IMAGE; attempt++) {
    try {
      const image = await generateOne(provider, prompt, (seed + attempt) & 0x7fffffff, budget, reference);
      const [text, semantic] = await Promise.all([checkGeneratedImageForText(image), narration ? checkGeneratedImageMatchesNarration(image, narration) : Promise.resolve(null)]);
      const failures: string[] = []; if (text?.hasVisibleText) failures.push(`visible text: ${text.reason}`); if (semantic?.contradictsNarration) failures.push(`contradicts narration: ${semantic.reason}`);
      if (!failures.length) return image; lastError = new Error(failures.join("; ")); logger.warn(`[illustrated_scene_assets] ${shotId}: vision QA failed attempt ${attempt + 1}/${MAX_ATTEMPTS_PER_ACCEPTED_IMAGE}: ${lastError.message}`);
    } catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); logger.warn(`[illustrated_scene_assets] ${shotId}: generation failed attempt ${attempt + 1}/${MAX_ATTEMPTS_PER_ACCEPTED_IMAGE}: ${lastError.message}`); }
  }
  throw lastError;
}

const HOOK_CANDIDATES = 3;
const HERO_CANDIDATES = 2;
const MAX_REVIEW_REGENERATIONS = 4;
const OPTIONAL_SPEND_CEILING = 70;
const MAX_PROVIDER_CALLS = 120;

export class ImageBudgetExhausted extends Error {
  constructor(calls: number) { super(`image provider call ceiling reached (${calls}/${MAX_PROVIDER_CALLS})`); }
}
class ImageBudget {
  private calls = 0;
  constructor(private readonly logger: WorkerContext["logger"]) {}
  chargeProviderCall(): void {
    if (this.calls >= MAX_PROVIDER_CALLS) throw new ImageBudgetExhausted(this.calls);
    this.calls += 1;
  }
  /** Reserve the worst-case provider calls for OPTIONAL work, including retries. */
  canAffordOptional(maxProviderCalls: number): boolean { return this.calls + maxProviderCalls <= OPTIONAL_SPEND_CEILING; }
  get spent(): number { return this.calls; }
  report(): void { this.logger.warn(`[illustrated_scene_assets] image provider calls this run: ${this.calls} (optional spend stops at ${OPTIONAL_SPEND_CEILING}, hard stop ${MAX_PROVIDER_CALLS})`); }
}

async function generateShot(provider: ReferenceCapableProvider, prompt: string, shot: DirectionShot, narration: string, reference: GeneratedImage | undefined, logger: WorkerContext["logger"], shotId: string, budget: ImageBudget, allowMultipleCandidates = true): Promise<GeneratedImage> {
  const seed = stableSeed(`${shotId}|${prompt}`);
  const wanted = shot.importance !== "hero" ? 1 : shot.hero_role === "hook" ? HOOK_CANDIDATES : HERO_CANDIDATES;
  const worstCaseCalls = wanted * MAX_ATTEMPTS_PER_ACCEPTED_IMAGE;
  const count = allowMultipleCandidates && wanted > 1 && budget.canAffordOptional(worstCaseCalls) ? wanted : 1;
  if (count === 1) return generateAccepted(provider, prompt, seed, reference, narration, logger, shotId, budget);

  const candidates: GeneratedImage[] = [];
  for (let i = 0; i < count; i++) {
    try { candidates.push(await generateAccepted(provider, prompt, (seed + i * 101) & 0x7fffffff, reference, narration, logger, `${shotId}#${i}`, budget)); }
    catch (err) { logger.warn(`[illustrated_scene_assets] ${shotId}: hero candidate ${i + 1}/${count} unavailable: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (!candidates.length) throw new Error(`all hero candidates failed for ${shotId}`); if (candidates.length === 1) return candidates[0]!;
  const ranked = await rankHeroImageCandidates(candidates, { prompt, narration, heroRole: shot.hero_role ?? "hero" }); return candidates[ranked?.bestIndex ?? 0]!;
}
interface WorkingShot { id: string; sceneIndex: number; shot: DirectionShot; narration: string; prompt: string; image?: GeneratedImage; source: "primary" | "fallback" | "placeholder" }
const aggregatePrompt = (items: Array<{ prompt: string }>) => items.map((i) => i.prompt).join("\n---SHOT---\n").slice(0, 1800);
function reviewPayload(review: VisualSequenceReviewResult | null, regenerated: string[]): Record<string, unknown> {
  const unavailableScores = { opening_visual_strength: 0, scene_relevance: 0, subject_legibility: 0, emotional_readability: 0, shot_variety: 0, visual_redundancy: 0, continuity: 0, style_consistency: 0, ai_artifacts: 0, payoff_visual_strength: 0 };
  if (!review) return { status: "unavailable", reviewed_shots: 0, regenerated_shots: regenerated, remaining_flagged_shots: [], scores: unavailableScores, reason: "episode-level visual review unavailable; scores are zero/unknown, not a synthetic pass" };
  return { status: review.flagged_shots.length ? "warn" : "pass", reviewed_shots: review.reviewed_shots, regenerated_shots: regenerated, remaining_flagged_shots: review.flagged_shots, scores: review.scores, reason: review.reason.slice(0, 1400) };
}

export function makeIllustratedSceneAssetsWorker(opts: IllustratedSceneAssetsWorkerOptions = {}): WorkerDef {
  return {
    name: "illustrated_scene_assets", kind: "worker", version: opts.version ?? "7",
    consumes: [{ schema_id: "episode_direction", range: "^2", as: "direction" }, { schema_id: "script", range: "^1", as: "script" }, { schema_id: "intent", range: "^1", as: "intent" }],
    produces: "asset_manifest", produces_version: "1.9.0",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const direction = inputs["direction"]!.payload as { scenes: DirectionScene[]; hero_shots: string[] };
      const scripts = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes; validateEpisodeDirection(direction, scripts.map((s) => s.scene_index));
      const intent = inputs["intent"]!.payload as IntentPayload, style = intent.image_style && intent.image_style in STYLE_BUNDLES ? intent.image_style : DEFAULT_STYLE;
      const narrationBy = new Map(scripts.map((s) => [s.scene_index, clean(s.narration, 600)])), outroIndex = scripts.find((s) => s.is_outro)?.scene_index;
      const configured = ctx.media.images as ReferenceCapableProvider | undefined, provider = configured && !configured.id.startsWith("fake/") ? configured : undefined;
      const orderedScenes = [...direction.scenes].sort((a, b) => a.scene_index - b.scene_index), working: WorkingShot[] = [], deferred: WorkingShot[] = [], budget = new ImageBudget(ctx.logger);
      const priorMap = new Map<number, PriorScene>(((ctx.priorArtifact?.payload as { scenes?: PriorScene[] } | undefined)?.scenes ?? []).filter((s): s is PriorScene & { scene_index: number } => typeof s.scene_index === "number").map((s) => [s.scene_index, s]));
      let reference: GeneratedImage | undefined;

      for (const scene of orderedScenes) {
        const shots = [...scene.shots].sort((a, b) => a.shot_index - b.shot_index);
        const fresh = shots.map((shot) => ({ shot, prompt: buildIllustratedPrompt(shot.image_prompt, style) }));
        const freshAggregate = aggregatePrompt(fresh);
        const prior = priorMap.get(scene.scene_index);
        const priorUris = prior?.image_uris?.length ? prior.image_uris : prior?.image_uri ? [prior.image_uri] : [];
        if (prior && prior.source !== "placeholder" && prior.prompt === freshAggregate && priorUris.length === fresh.length) {
          try {
            const reused: WorkingShot[] = [];
            for (let i = 0; i < fresh.length; i++) {
              const image = { bytes: await ctx.blobs.get(priorUris[i]!), media_type: "image/png" };
              reused.push({ id: `${scene.scene_index}:${fresh[i]!.shot.shot_index}`, sceneIndex: scene.scene_index, shot: fresh[i]!.shot, narration: narrationBy.get(scene.scene_index) ?? "", prompt: fresh[i]!.prompt, image, source: prior.source! });
              if (!reference && prior.source === "primary") reference = image;
            }
            working.push(...reused); continue;
          } catch { }
        }
        for (const { shot, prompt } of fresh) {
          const id = `${scene.scene_index}:${shot.shot_index}`, narration = narrationBy.get(scene.scene_index) ?? "";
          const item: WorkingShot = { id, sceneIndex: scene.scene_index, shot, narration, prompt, source: "placeholder" };
          if (provider) {
            try { item.image = await generateShot(provider, prompt, shot, narration, reference, ctx.logger, id, budget); item.source = "primary"; if (!reference) reference = item.image; }
            catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (reference) { item.image = reference; item.source = "fallback"; ctx.logger.warn(`[illustrated_scene_assets] ${id}: reusing reference after failure: ${message}`); }
              else { deferred.push(item); ctx.logger.warn(`[illustrated_scene_assets] ${id}: failed with no reference available yet; deferring one retry until a later scene establishes one: ${message}`); }
            }
          }
          working.push(item);
        }
      }

      for (const item of deferred) {
        if (!provider || !reference) break;
        try {
          item.image = await generateShot(provider, item.prompt, item.shot, item.narration, reference, ctx.logger, `${item.id}:deferred`, budget);
          item.source = "primary";
          ctx.logger.warn(`[illustrated_scene_assets] ${item.id}: deferred retry succeeded with reference conditioning; render receives a real image instead of a blank frame`);
        } catch (err) {
          item.image = reference; item.source = "fallback";
          ctx.logger.warn(`[illustrated_scene_assets] ${item.id}: deferred retry also failed; reusing the episode reference rather than shipping blank: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const sequenceEntries = (): VisualSequenceEntry[] => working.filter((w): w is WorkingShot & { image: GeneratedImage } => Boolean(w.image)).map((w) => ({ shot_id: w.id, image: w.image, narration: w.narration, prompt: w.shot.image_prompt, shot_function: w.shot.shot_function, hero: w.shot.importance === "hero" }));
      let review = await reviewIllustratedSequence(sequenceEntries()); const regenerated: string[] = [];
      if (provider && review?.flagged_shots.length) {
        for (const id of review.flagged_shots.slice(0, MAX_REVIEW_REGENERATIONS)) {
          const item = working.find((w) => w.id === id);
          if (!item) continue;
          if (!budget.canAffordOptional(MAX_ATTEMPTS_PER_ACCEPTED_IMAGE)) { ctx.logger.warn(`[illustrated_scene_assets] ${id}: flagged by review but the optional-spend budget is spent; keeping the existing image`); break; }
          try {
            item.image = await generateShot(provider, item.prompt, item.shot, item.narration, reference, ctx.logger, `${id}:review`, budget, false);
            item.source = "primary";
            regenerated.push(id);
          } catch (err) { ctx.logger.warn(`[illustrated_scene_assets] ${id}: targeted review regeneration failed: ${err instanceof Error ? err.message : String(err)}`); }
        }
        if (regenerated.length) review = await reviewIllustratedSequence(sequenceEntries());
      }

      const blobs: BlobRef[] = [], scenes: Array<Record<string, unknown>> = []; let degraded = 0;
      for (const scene of orderedScenes) {
        const items = working.filter((w) => w.sceneIndex === scene.scene_index).sort((a, b) => a.shot.shot_index - b.shot.shot_index), uris: string[] = [];
        for (const item of items) if (item.image) { const ref = await ctx.blobs.put(item.image.bytes, { role: "image", media_type: item.image.media_type }); blobs.push(ref); uris.push(ref.uri); }
        const source = uris.length === 0 ? "placeholder" : items.some((i) => !i.image || i.source === "fallback") ? "fallback" : "primary"; if (source !== "primary") degraded++;
        const templateData = JSON.stringify({ camera_move: items[0]?.shot.camera_move ?? "hold", camera_moves: items.map((i) => i.shot.camera_move), shot_functions: items.map((i) => i.shot.shot_function), ...(scene.on_screen_label ? { on_screen_label: scene.on_screen_label } : {}), ...(scene.scene_index === outroIndex ? { line: narrationBy.get(scene.scene_index) ?? "" } : {}) });
        scenes.push({ scene_index: scene.scene_index, source, ...(uris[0] ? { image_uri: uris[0] } : {}), ...(uris.length ? { image_uris: uris } : {}), prompt: aggregatePrompt(items), template_data: templateData, shot_types: items.map((i) => i.shot.shot_function), hero_shot_ids: items.filter((i) => i.shot.importance === "hero").map((i) => i.id) });
      }
      const first = scenes.find((s) => s["scene_index"] === 0); if (!first || (!first["image_uri"] && first["source"] !== "placeholder")) throw new Error("illustrated visual invariant failed: scene 0 has no renderable visual or explicit placeholder");
      budget.report();
      return { payload: { scenes, degraded_count: degraded, visual_review: reviewPayload(review, regenerated) }, blobs };
    },
  };
}
