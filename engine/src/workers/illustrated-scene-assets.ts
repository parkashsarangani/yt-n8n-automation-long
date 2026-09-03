/**
 * RFC 0009 illustrated asset worker.
 * One narration scene is a writing unit, not an editing unit: direction@2
 * supplies 1-3 shots. Hero shots receive best-of-three generation; the full
 * ordered episode receives one compact visual review and targeted regeneration.
 */
import type { Artifact, BlobRef } from "../artifact.ts";
import {
  checkGeneratedImageForText,
  checkGeneratedImageMatchesNarration,
  rankHeroImageCandidates,
  reviewIllustratedSequence,
  type VisualSequenceEntry,
  type VisualSequenceReviewResult,
} from "../image-qa.ts";
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
interface ReferenceCapableProvider extends ImageProvider {
  generatePack?: (req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) => Promise<{ images: GeneratedImage[] }>;
}
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
export function buildIllustratedPrompt(subject: string, style: ImageStyle): string {
  const bundle = STYLE_BUNDLES[style] ?? STYLE_BUNDLES[DEFAULT_STYLE];
  return `${clean(subject, 500)}. VISUAL IDENTITY: ${bundle.positive}. EXCLUDE: ${bundle.negative}. No typography.`;
}

/** Hard deterministic enforcement for Decisions 3-5. */
export function validateEpisodeDirection(direction: { scenes: DirectionScene[]; hero_shots: string[] }, scriptSceneIndices: number[]): void {
  const errors: string[] = [];
  const scriptSet = new Set(scriptSceneIndices);
  const declared = direction.hero_shots;
  if (new Set(declared).size !== declared.length) errors.push("hero_shots contains duplicates");
  if (declared.length < 3 || declared.length > 5) errors.push(`hero_shots has ${declared.length}; requires 3-5`);
  const actualHeroes: string[] = [];
  const flatFunctions: ShotFunction[] = [];
  const seenScenes = new Set<number>();
  for (const scene of [...direction.scenes].sort((a, b) => a.scene_index - b.scene_index)) {
    if (seenScenes.has(scene.scene_index)) errors.push(`scene ${scene.scene_index} is duplicated`);
    seenScenes.add(scene.scene_index);
    if (!scriptSet.has(scene.scene_index)) errors.push(`direction scene ${scene.scene_index} has no script scene`);
    const seenShot = new Set<number>();
    const sorted = [...scene.shots].sort((a, b) => a.shot_index - b.shot_index);
    sorted.forEach((shot, position) => {
      if (seenShot.has(shot.shot_index)) errors.push(`scene ${scene.scene_index} repeats shot_index ${shot.shot_index}`);
      seenShot.add(shot.shot_index);
      if (shot.shot_index !== position) errors.push(`scene ${scene.scene_index} shot indices must be contiguous from 0`);
      const id = `${scene.scene_index}:${shot.shot_index}`;
      if (shot.importance === "hero") actualHeroes.push(id);
      if (shot.importance === "hero" && !shot.hero_role) errors.push(`hero shot ${id} has no hero_role`);
      if (shot.importance === "normal" && shot.hero_role) errors.push(`normal shot ${id} carries hero_role`);
      flatFunctions.push(shot.shot_function);
    });
  }
  for (const idx of scriptSet) if (!seenScenes.has(idx)) errors.push(`script scene ${idx} has no direction scene`);
  const declaredSorted = [...declared].sort();
  const actualSorted = [...actualHeroes].sort();
  if (JSON.stringify(declaredSorted) !== JSON.stringify(actualSorted)) errors.push(`hero_shots does not match shots marked hero (declared=${declaredSorted.join(",")}; actual=${actualSorted.join(",")})`);
  for (let i = 2; i < flatFunctions.length; i++) {
    if (flatFunctions[i] === flatFunctions[i - 1] && flatFunctions[i] === flatFunctions[i - 2]) errors.push(`three consecutive shots use ${flatFunctions[i]}`);
  }
  if (errors.length) throw new Error(`episode direction invariant failed: ${errors.join("; ")}`);
}

function stableSeed(value: string): number { let h = 2166136261; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) & 0x7fffffff; }
async function generateOne(provider: ReferenceCapableProvider, prompt: string, seed: number, reference?: GeneratedImage): Promise<GeneratedImage> {
  if (provider.generatePack) {
    const out = await provider.generatePack({ prompts: [prompt], aspect: "16:9", seed, ...(reference ? { reference } : {}) });
    const image = out.images[0]; if (!image) throw new Error("image provider returned no image"); return image;
  }
  const out = await provider.generate({ prompt, aspect: "16:9", count: 1 });
  const image = out.images[0]; if (!image) throw new Error("image provider returned no image"); return image;
}
async function generateAccepted(provider: ReferenceCapableProvider, prompt: string, seed: number, reference: GeneratedImage | undefined, narration: string, logger: WorkerContext["logger"], shotId: string): Promise<GeneratedImage> {
  let lastError = new Error("image generation failed");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const image = await generateOne(provider, prompt, (seed + attempt) & 0x7fffffff, reference);
      const [text, semantic] = await Promise.all([checkGeneratedImageForText(image), narration ? checkGeneratedImageMatchesNarration(image, narration) : Promise.resolve(null)]);
      const failures: string[] = [];
      if (text?.hasVisibleText) failures.push(`visible text: ${text.reason}`);
      if (semantic?.contradictsNarration) failures.push(`contradicts narration: ${semantic.reason}`);
      if (!failures.length) return image;
      lastError = new Error(failures.join("; "));
      logger.warn(`[illustrated_scene_assets] ${shotId}: vision QA failed attempt ${attempt + 1}/2: ${lastError.message}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(`[illustrated_scene_assets] ${shotId}: generation failed attempt ${attempt + 1}/2: ${lastError.message}`);
    }
  }
  throw lastError;
}
async function generateShot(provider: ReferenceCapableProvider, prompt: string, shot: DirectionShot, narration: string, reference: GeneratedImage | undefined, logger: WorkerContext["logger"], shotId: string): Promise<GeneratedImage> {
  const seed = stableSeed(`${shotId}|${prompt}`);
  if (shot.importance !== "hero") return generateAccepted(provider, prompt, seed, reference, narration, logger, shotId);
  const candidates: GeneratedImage[] = [];
  for (let i = 0; i < 3; i++) {
    try { candidates.push(await generateAccepted(provider, prompt, (seed + i * 101) & 0x7fffffff, reference, narration, logger, `${shotId}#${i}`)); }
    catch (err) { logger.warn(`[illustrated_scene_assets] ${shotId}: hero candidate ${i + 1}/3 unavailable: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (!candidates.length) throw new Error(`all hero candidates failed for ${shotId}`);
  if (candidates.length === 1) return candidates[0]!;
  const ranked = await rankHeroImageCandidates(candidates, { prompt, narration, heroRole: shot.hero_role ?? "hero" });
  return candidates[ranked?.bestIndex ?? 0]!;
}
interface WorkingShot { id: string; sceneIndex: number; shot: DirectionShot; narration: string; prompt: string; image?: GeneratedImage; source: "primary" | "fallback" | "placeholder" }
function reviewPayload(review: VisualSequenceReviewResult | null, regenerated: string[]): Record<string, unknown> {
  const unavailableScores = { opening_visual_strength: 0, scene_relevance: 0, subject_legibility: 0, emotional_readability: 0, shot_variety: 0, visual_redundancy: 0, continuity: 0, style_consistency: 0, ai_artifacts: 0, payoff_visual_strength: 0 };
  if (!review) return { status: "unavailable", reviewed_shots: 0, regenerated_shots: regenerated, remaining_flagged_shots: [], scores: unavailableScores, reason: "episode-level visual review unavailable; scores are intentionally zero/unknown, not a synthetic pass" };
  return { status: review.flagged_shots.length === 0 ? "pass" : "warn", reviewed_shots: review.reviewed_shots, regenerated_shots: regenerated, remaining_flagged_shots: review.flagged_shots, scores: review.scores, reason: review.reason.slice(0, 1400) };
}

export function makeIllustratedSceneAssetsWorker(opts: IllustratedSceneAssetsWorkerOptions = {}): WorkerDef {
  return {
    name: "illustrated_scene_assets", kind: "worker", version: opts.version ?? "5",
    consumes: [
      { schema_id: "episode_direction", range: "^2", as: "direction" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "intent", range: "^1", as: "intent" },
    ],
    produces: "asset_manifest", produces_version: "2.0.0",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const direction = inputs["direction"]!.payload as { scenes: DirectionScene[]; hero_shots: string[] };
      const scripts = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      validateEpisodeDirection(direction, scripts.map((s) => s.scene_index));
      const intent = inputs["intent"]!.payload as IntentPayload;
      const style = intent.image_style && intent.image_style in STYLE_BUNDLES ? intent.image_style : DEFAULT_STYLE;
      const narrationBy = new Map(scripts.map((s) => [s.scene_index, clean(s.narration, 600)]));
      const outroIndex = scripts.find((s) => s.is_outro)?.scene_index;
      const configured = ctx.media.images as ReferenceCapableProvider | undefined;
      const provider = configured && !configured.id.startsWith("fake/") ? configured : undefined;
      const orderedScenes = [...direction.scenes].sort((a, b) => a.scene_index - b.scene_index);
      const working: WorkingShot[] = [];
      let reference: GeneratedImage | undefined;
      for (const scene of orderedScenes) {
        for (const shot of [...scene.shots].sort((a, b) => a.shot_index - b.shot_index)) {
          const id = `${scene.scene_index}:${shot.shot_index}`;
          const narration = narrationBy.get(scene.scene_index) ?? "";
          const prompt = buildIllustratedPrompt(shot.image_prompt, style);
          const item: WorkingShot = { id, sceneIndex: scene.scene_index, shot, narration, prompt, source: "placeholder" };
          if (provider) {
            try { item.image = await generateShot(provider, prompt, shot, narration, reference, ctx.logger, id); item.source = "primary"; if (!reference) reference = item.image; }
            catch (err) {
              if (reference) { item.image = reference; item.source = "fallback"; ctx.logger.warn(`[illustrated_scene_assets] ${id}: reusing reference after failure: ${err instanceof Error ? err.message : String(err)}`); }
              else ctx.logger.warn(`[illustrated_scene_assets] ${id}: no renderable image after failure: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          working.push(item);
        }
      }
      const sequenceEntries = (): VisualSequenceEntry[] => working.filter((w): w is WorkingShot & { image: GeneratedImage } => Boolean(w.image)).map((w) => ({ shot_id: w.id, image: w.image, narration: w.narration, prompt: w.shot.image_prompt, shot_function: w.shot.shot_function, hero: w.shot.importance === "hero" }));
      let review = await reviewIllustratedSequence(sequenceEntries());
      const regenerated: string[] = [];
      if (provider && review?.flagged_shots.length) {
        for (const id of review.flagged_shots.slice(0, 12)) {
          const item = working.find((w) => w.id === id); if (!item) continue;
          try { item.image = await generateShot(provider, item.prompt, item.shot, item.narration, reference, ctx.logger, `${id}:review`); item.source = "primary"; regenerated.push(id); }
          catch (err) { ctx.logger.warn(`[illustrated_scene_assets] ${id}: targeted visual-review regeneration failed: ${err instanceof Error ? err.message : String(err)}`); }
        }
        if (regenerated.length) review = await reviewIllustratedSequence(sequenceEntries());
      }
      const blobs: BlobRef[] = [];
      const scenes: Array<Record<string, unknown>> = [];
      let degraded = 0;
      for (const scene of orderedScenes) {
        const items = working.filter((w) => w.sceneIndex === scene.scene_index).sort((a, b) => a.shot.shot_index - b.shot.shot_index);
        const uris: string[] = [];
        for (const item of items) {
          if (!item.image) continue;
          const ref = await ctx.blobs.put(item.image.bytes, { role: "image", media_type: item.image.media_type }); blobs.push(ref); uris.push(ref.uri);
        }
        const source = uris.length === 0 ? "placeholder" : items.some((i) => !i.image || i.source === "fallback") ? "fallback" : "primary";
        if (source !== "primary") degraded++;
        const templateData = JSON.stringify({ camera_move: items[0]?.shot.camera_move ?? "hold", camera_moves: items.map((i) => i.shot.camera_move), shot_functions: items.map((i) => i.shot.shot_function), ...(scene.on_screen_label ? { on_screen_label: scene.on_screen_label } : {}), ...(scene.scene_index === outroIndex ? { line: narrationBy.get(scene.scene_index) ?? "" } : {}) });
        scenes.push({ scene_index: scene.scene_index, source, ...(uris[0] ? { image_uri: uris[0] } : {}), ...(uris.length ? { image_uris: uris } : {}), prompt: items.map((i) => i.prompt).join("\n---SHOT---\n").slice(0, 1800), template_data: templateData, shot_types: items.map((i) => i.shot.shot_function), hero_shot_ids: items.filter((i) => i.shot.importance === "hero").map((i) => i.id) });
      }
      const first = scenes.find((s) => s["scene_index"] === 0);
      if (!first || (!first["image_uri"] && first["source"] !== "placeholder")) throw new Error("illustrated visual invariant failed: scene 0 has no renderable visual or explicit placeholder");
      return { payload: { scenes, degraded_count: degraded, visual_review: reviewPayload(review, regenerated) }, blobs };
    },
  };
}
