import type { Artifact, BlobRef } from "../artifact.ts";
import type { Aspect, ImageProvider } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import {
  checkGeneratedImageForText,
  checkGeneratedImageMatchesNarration,
  rankHeroImageCandidates,
  reviewIllustratedSequence,
  type VisualSequenceEntry,
  type VisualSequenceReviewResult,
} from "../image-qa.ts";
import { buildIllustratedPrompt } from "./illustrated-scene-assets.ts";

interface DirectionShot {
  shot_index: number;
  image_prompt: string;
  camera_move: "push-in" | "pull-out" | "pan-left" | "pan-right" | "hold";
  shot_function: string;
  importance: "normal" | "hero";
  hero_role?: string;
}
interface DirectionScene {
  scene_index: number;
  shots?: DirectionShot[];
  // 1.0 compatibility for resumable/historical payloads.
  image_prompt?: string;
  camera_move?: DirectionShot["camera_move"];
  on_screen_label?: string;
}
interface DirectionPayload { scenes: DirectionScene[]; hero_shots?: string[] }
interface ScriptScene { scene_index: number; narration?: string; is_outro?: boolean }
type ImageStyle = "ink_wash_stickman" | "flat_comic_expressive" | "documentary_sketch" | "watercolor_storybook" | "noir_charcoal";
interface IntentPayload { image_style?: ImageStyle }
interface GeneratedImage { bytes: Uint8Array; media_type: string }
interface ReferenceCapableProvider extends ImageProvider {
  generatePack?: (req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) => Promise<{ images: GeneratedImage[] }>;
}

export interface IllustratedGrowthAssetsWorkerOptions { version?: string }

function clean(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function stableSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i)!; h = Math.imul(h, 16777619); }
  return (h >>> 0) & 0x7fffffff;
}

function normaliseScene(scene: DirectionScene): { scene_index: number; on_screen_label?: string; shots: DirectionShot[] } {
  if (Array.isArray(scene.shots) && scene.shots.length > 0) {
    return {
      scene_index: scene.scene_index,
      ...(scene.on_screen_label ? { on_screen_label: scene.on_screen_label } : {}),
      shots: [...scene.shots].sort((a, b) => a.shot_index - b.shot_index).slice(0, 3),
    };
  }
  // Resume compatibility: old episode_direction@1.0 had one prompt/move.
  return {
    scene_index: scene.scene_index,
    ...(scene.on_screen_label ? { on_screen_label: scene.on_screen_label } : {}),
    shots: [{
      shot_index: 0,
      image_prompt: clean(scene.image_prompt, 360) || "a concrete story moment",
      camera_move: scene.camera_move ?? "push-in",
      shot_function: "medium",
      importance: scene.scene_index === 0 ? "hero" : "normal",
      ...(scene.scene_index === 0 ? { hero_role: "hook" } : {}),
    }],
  };
}

async function generateOne(provider: ReferenceCapableProvider, prompt: string, seed: number, reference?: GeneratedImage): Promise<GeneratedImage> {
  if (provider.generatePack) {
    const out = await provider.generatePack({ prompts: [prompt], aspect: "16:9", seed, ...(reference ? { reference } : {}) });
    const image = out.images[0];
    if (!image) throw new Error("image provider returned no image");
    return image;
  }
  const out = await provider.generate({ prompt, aspect: "16:9", count: 1 });
  const image = out.images[0];
  if (!image) throw new Error("image provider returned no image");
  return image;
}

async function generateClean(
  provider: ReferenceCapableProvider,
  prompt: string,
  seed: number,
  reference: GeneratedImage | undefined,
  narration: string,
  logger: WorkerContext["logger"],
  shotId: string,
): Promise<GeneratedImage> {
  let lastError = new Error("generation failed");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const image = await generateOne(provider, prompt, (seed + attempt) & 0x7fffffff, reference);
      const [text, semantic] = await Promise.all([
        checkGeneratedImageForText(image),
        narration ? checkGeneratedImageMatchesNarration(image, narration) : Promise.resolve(null),
      ]);
      const failures: string[] = [];
      if (text?.hasVisibleText) failures.push(`visible text: ${text.reason}`);
      if (semantic?.contradictsNarration) failures.push(`contradiction: ${semantic.reason}`);
      if (failures.length === 0) return image;
      lastError = new Error(failures.join("; "));
      logger.warn(`[illustrated_scene_assets] ${shotId} failed per-image QA (${failures.join("; ")})${attempt === 0 ? "; retrying" : ""}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(`[illustrated_scene_assets] ${shotId} generation failed (${lastError.message})${attempt === 0 ? "; retrying" : ""}`);
    }
  }
  throw lastError;
}

async function generateHero(
  provider: ReferenceCapableProvider,
  prompt: string,
  seed: number,
  reference: GeneratedImage | undefined,
  narration: string,
  role: string,
  logger: WorkerContext["logger"],
  shotId: string,
): Promise<GeneratedImage> {
  const candidates: GeneratedImage[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      candidates.push(await generateClean(provider, prompt, (seed + i * 1009) & 0x7fffffff, reference, narration, logger, `${shotId} candidate ${i}`));
    } catch {
      // One failed candidate must not erase successful alternatives.
    }
  }
  if (candidates.length === 0) throw new Error(`all hero candidates failed for ${shotId}`);
  if (candidates.length === 1) return candidates[0]!;
  const rank = await rankHeroImageCandidates(candidates, { prompt, narration, heroRole: role });
  return candidates[rank?.bestIndex ?? 0]!;
}

interface RuntimeShot {
  id: string;
  sceneIndex: number;
  shot: DirectionShot;
  narration: string;
  providerPrompt: string;
  image?: GeneratedImage;
  existingUri?: string;
  fallback: boolean;
}

const REVIEW_PASS_FLOOR = 0.68;

function reviewStatus(review: VisualSequenceReviewResult | null): "pass" | "warn" | "unavailable" {
  if (!review) return "unavailable";
  const min = Math.min(...Object.values(review.scores));
  return review.flagged_shots.length === 0 && min >= REVIEW_PASS_FLOOR ? "pass" : "warn";
}

export function makeIllustratedGrowthAssetsWorker(opts: IllustratedGrowthAssetsWorkerOptions = {}): WorkerDef {
  return {
    // Same transformation id as RFC 0008. The graph does not fork; this is a
    // versioned implementation of the same side-effect stage.
    name: "illustrated_scene_assets",
    kind: "worker",
    version: opts.version ?? "5",
    consumes: [
      { schema_id: "episode_direction", range: "^1", as: "direction" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "intent", range: "^1", as: "intent" },
    ],
    produces: "asset_manifest",
    produces_version: "1.9.0",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const direction = inputs["direction"]!.payload as DirectionPayload;
      const scripts = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const intent = inputs["intent"]!.payload as IntentPayload;
      const style: ImageStyle = intent.image_style ?? "ink_wash_stickman";
      const narrationBy = new Map(scripts.map((s) => [s.scene_index, clean(s.narration, 500)]));
      const outroSceneIndex = scripts.find((s) => s.is_outro === true)?.scene_index;
      const scenes = [...direction.scenes].sort((a, b) => a.scene_index - b.scene_index).map(normaliseScene);
      const configured = ctx.media.images as ReferenceCapableProvider | undefined;
      const provider = configured && !configured.id.startsWith("fake/") ? configured : undefined;

      const priorPayload = ctx.priorArtifact?.payload as { scenes?: Array<Record<string, unknown>> } | undefined;
      const priorByScene = new Map<number, Record<string, unknown>>(
        (priorPayload?.scenes ?? [])
          .filter((s) => typeof s["scene_index"] === "number")
          .map((s) => [s["scene_index"] as number, s]),
      );

      const runtime: RuntimeShot[] = [];
      let referenceImage: GeneratedImage | undefined;
      let degraded = 0;

      // Seed continuity from an intact prior primary scene on a targeted retry.
      for (const scene of scenes) {
        const prior = priorByScene.get(scene.scene_index);
        const uri = Array.isArray(prior?.["image_uris"]) ? (prior?.["image_uris"] as string[])[0] : prior?.["image_uri"];
        if (prior?.["source"] !== "primary" || typeof uri !== "string") continue;
        try { referenceImage = { bytes: await ctx.blobs.get(uri), media_type: "image/png" }; } catch { /* regenerate */ }
        if (referenceImage) break;
      }

      for (const scene of scenes) {
        const signature = scene.shots.map((s) => clean(s.image_prompt, 360)).join(" || ");
        const prior = priorByScene.get(scene.scene_index);
        const priorUris = Array.isArray(prior?.["image_uris"])
          ? prior?.["image_uris"] as string[]
          : typeof prior?.["image_uri"] === "string" ? [prior["image_uri"] as string] : [];
        const priorReusable = prior?.["source"] !== "placeholder" && prior?.["prompt"] === signature && priorUris.length === scene.shots.length;

        for (const shot of scene.shots) {
          const id = `${scene.scene_index}:${shot.shot_index}`;
          const narration = narrationBy.get(scene.scene_index) ?? "";
          const providerPrompt = buildIllustratedPrompt(shot.image_prompt, style);
          if (priorReusable) {
            const existingUri = priorUris[shot.shot_index];
            if (existingUri) {
              let image: GeneratedImage | undefined;
              try { image = { bytes: await ctx.blobs.get(existingUri), media_type: "image/png" }; } catch { /* regenerate below */ }
              if (image) {
                runtime.push({ id, sceneIndex: scene.scene_index, shot, narration, providerPrompt, image, existingUri, fallback: prior?.["source"] === "fallback" });
                if (!referenceImage && prior?.["source"] === "primary") referenceImage = image;
                continue;
              }
            }
          }

          if (!provider) {
            runtime.push({ id, sceneIndex: scene.scene_index, shot, narration, providerPrompt, fallback: true });
            degraded++;
            continue;
          }

          const seed = stableSeed(`${id}|${providerPrompt}`);
          try {
            const image = shot.importance === "hero"
              ? await generateHero(provider, providerPrompt, seed, referenceImage, narration, shot.hero_role ?? "hero", ctx.logger, id)
              : await generateClean(provider, providerPrompt, seed, referenceImage, narration, ctx.logger, id);
            runtime.push({ id, sceneIndex: scene.scene_index, shot, narration, providerPrompt, image, fallback: false });
            referenceImage = image;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (referenceImage) {
              ctx.logger.warn(`[illustrated_scene_assets] ${id} failed; using current continuity reference instead of a blank frame: ${message}`);
              runtime.push({ id, sceneIndex: scene.scene_index, shot, narration, providerPrompt, image: referenceImage, fallback: true });
            } else {
              ctx.logger.warn(`[illustrated_scene_assets] ${id} failed with no reference available: ${message}`);
              runtime.push({ id, sceneIndex: scene.scene_index, shot, narration, providerPrompt, fallback: true });
            }
            degraded++;
          }
        }
      }

      const toReviewEntries = (): VisualSequenceEntry[] => runtime
        .filter((r): r is RuntimeShot & { image: GeneratedImage } => Boolean(r.image))
        .map((r) => ({
          shot_id: r.id,
          image: r.image,
          narration: r.narration,
          prompt: clean(r.shot.image_prompt, 360),
          shot_function: r.shot.shot_function,
          hero: r.shot.importance === "hero",
        }));

      let review = provider ? await reviewIllustratedSequence(toReviewEntries()) : null;
      const regenerated: string[] = [];

      // One targeted correction pass only. No full-episode reroll and no
      // semantic-agent chain: regenerate exactly what the actual images say is
      // hurting the sequence, while their prompts/reference context still exist.
      if (provider && review?.flagged_shots.length) {
        const flagged = new Set(review.flagged_shots.slice(0, 12));
        for (let i = 0; i < runtime.length; i++) {
          const item = runtime[i]!;
          if (!flagged.has(item.id)) continue;
          const seed = (stableSeed(`${item.id}|${item.providerPrompt}`) + 7919) & 0x7fffffff;
          const previous = [...runtime.slice(0, i)].reverse().find((r) => r.image)?.image;
          try {
            const fresh = item.shot.importance === "hero"
              ? await generateHero(provider, item.providerPrompt, seed, previous, item.narration, item.shot.hero_role ?? "hero", ctx.logger, `${item.id} review-regeneration`)
              : await generateClean(provider, item.providerPrompt, seed, previous, item.narration, ctx.logger, `${item.id} review-regeneration`);
            item.image = fresh;
            item.existingUri = undefined;
            item.fallback = false;
            regenerated.push(item.id);
          } catch (err) {
            ctx.logger.warn(`[illustrated_scene_assets] targeted visual-review regeneration failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (regenerated.length > 0) review = await reviewIllustratedSequence(toReviewEntries()) ?? review;
      }

      const blobs: BlobRef[] = [];
      const manifestScenes: Array<Record<string, unknown>> = [];
      for (const scene of scenes) {
        const items = runtime.filter((r) => r.sceneIndex === scene.scene_index).sort((a, b) => a.shot.shot_index - b.shot.shot_index);
        const uris: string[] = [];
        let source: "primary" | "fallback" | "placeholder" = "primary";
        for (const item of items) {
          if (!item.image) { source = "placeholder"; continue; }
          if (item.fallback && source === "primary") source = "fallback";
          if (item.existingUri) {
            uris.push(item.existingUri);
          } else {
            const ref = await ctx.blobs.put(item.image.bytes, { role: "image", media_type: item.image.media_type });
            blobs.push(ref);
            uris.push(ref.uri);
          }
        }
        if (uris.length === 0) source = "placeholder";
        const heroShotIds = items.filter((r) => r.shot.importance === "hero").map((r) => r.id);
        const templateData = JSON.stringify({
          camera_move: items[0]?.shot.camera_move ?? "hold",
          camera_moves: items.map((r) => r.shot.camera_move),
          shot_functions: items.map((r) => r.shot.shot_function),
          hero_shot_ids: heroShotIds,
          ...(scene.on_screen_label ? { on_screen_label: scene.on_screen_label } : {}),
          ...(scene.scene_index === outroSceneIndex ? { line: narrationBy.get(scene.scene_index) ?? "" } : {}),
        });
        const signature = scene.shots.map((s) => clean(s.image_prompt, 360)).join(" || ");
        manifestScenes.push({
          scene_index: scene.scene_index,
          source,
          ...(uris[0] ? { image_uri: uris[0] } : {}),
          ...(uris.length > 1 ? { image_uris: uris } : {}),
          prompt: signature,
          template_data: templateData,
          shot_types: items.map((r) => r.shot.shot_function),
          hero_shot_ids: heroShotIds,
        });
      }

      const first = manifestScenes.find((s) => s["scene_index"] === 0);
      if (!first || (!(first["image_uri"]) && first["source"] !== "placeholder")) {
        throw new Error("illustrated visual invariant failed: literal scene 0 has no renderable visual");
      }

      const unavailableScores = {
        opening_visual_strength: 0,
        scene_relevance: 0,
        subject_legibility: 0,
        emotional_readability: 0,
        shot_variety: 0,
        visual_redundancy: 0,
        continuity: 0,
        style_consistency: 0,
        ai_artifacts: 0,
        payoff_visual_strength: 0,
      };
      const visualReview = {
        status: reviewStatus(review),
        reviewed_shots: review?.reviewed_shots ?? 0,
        regenerated_shots: regenerated,
        remaining_flagged_shots: review?.flagged_shots ?? [],
        scores: review?.scores ?? unavailableScores,
        reason: review?.reason ?? "episode-level vision review unavailable; per-image QA/fallback policy still applied",
      };

      return { payload: { scenes: manifestScenes, degraded_count: degraded, visual_review: visualReview }, blobs };
    },
  };
}
