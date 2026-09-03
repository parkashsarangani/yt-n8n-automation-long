/**
 * Illustrated scene assets worker: episode_direction -> asset_manifest (RFC 0008).
 *
 * The illustrated-story format has no characters, no diagrams, no template
 * scenes -- every scene is one generated still under the locked house style.
 * This is deliberately a much smaller worker than hybrid_visual_assets: no
 * continuity groups per character, no entity identity tokens, no shot packs.
 * The whole episode shares ONE visual identity, established by the first
 * generated image and held via reference-image conditioning on every
 * subsequent scene -- prose style descriptions drift between generations;
 * a reference image does not (RFC 0008 decision 2).
 *
 * "Locked" originally meant one style, chosen by us. It now means one style
 * PER RUN, chosen by the operator via intent.image_style -- still nothing an
 * agent can drift on mid-episode, just no longer only one option system-wide.
 */

import type { Artifact, BlobRef } from "../artifact.ts";
import { checkGeneratedImageForText, checkGeneratedImageMatchesNarration } from "../image-qa.ts";
import type { Aspect, ImageProvider } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

interface DirectionScene {
  scene_index: number;
  image_prompt: string;
  camera_move: "push-in" | "pull-out" | "pan-left" | "pan-right" | "hold";
  on_screen_label?: string;
}
interface ScriptScene { scene_index: number; narration?: string; is_outro?: boolean }
interface IntentPayload { image_style?: ImageStyle }
type ImageStyle = "ink_wash_stickman" | "flat_comic_expressive" | "documentary_sketch" | "watercolor_storybook" | "noir_charcoal";
interface GeneratedImage { bytes: Uint8Array; media_type: string }
interface ReferenceCapableProvider extends ImageProvider {
  generatePack?: (req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) => Promise<{ images: GeneratedImage[] }>;
}

export interface IllustratedSceneAssetsWorkerOptions {
  version?: string;
}

const DEFAULT_STYLE: ImageStyle = "ink_wash_stickman";

/**
 * One locked visual identity per style, matching intent.image_style
 * (schemas/intent/1.1.0.json). Both a `houseStyle` (positive description) and
 * `negatives` (excludes) -- reference-image conditioning (in execute() below)
 * still carries the actual continuity across an episode; this text is the
 * floor for scene 0, before a reference exists, and for providers with no
 * reference support.
 */
const STYLE_BUNDLES: Record<ImageStyle, { houseStyle: string; negatives: string }> = {
  // RFC 0008 decision 2, verbatim. The original and still the default.
  ink_wash_stickman: {
    houseStyle: [
      "hand-drawn pen-and-ink illustration with a muted wash, single consistent art style across a series",
      "human figures are minimal and faceless -- simple stick figures with basic clothing shapes, no facial features",
      "environments, objects and animals are rendered with real detail and texture, in contrast to the abstract human figures",
      "muted, near-monochrome palette: sepia, ochre, dusty green, warm neutrals -- no saturated color",
      "wide composition, subject off-centre, real negative space, visible horizon where relevant",
      "visible paper grain texture uniformly across the image",
    ].join(", "),
    negatives: [
      "no photorealistic humans",
      "no glossy 3D render",
      "no dramatic rim lighting",
      "no lens flare",
      "no hyperreal skin",
      "no centered symmetrical hero shot",
      "no text, no letters, no captions, no logos, no watermark",
    ].join(", "),
  },
  // A second, deliberately different identity: drama and true_story genres
  // often need a reaction shot to read as a specific emotion, which a
  // faceless figure can't carry. Flat vector color instead of ink wash so the
  // two styles are visually distinct at a glance, not just a face variant of
  // the same look.
  flat_comic_expressive: {
    houseStyle: [
      "flat 2D vector illustration, bold confident black outlines, single consistent art style across a series",
      "human figures are simplified and geometric but have expressive minimal faces -- a few clean lines for eyes/brows/mouth that clearly read an emotion (shock, grief, relief, anger)",
      "environments and objects are simplified to flat shapes with the same bold outline, not photorealistic detail",
      "a bright but limited flat color palette, 4-6 colors per scene, strong contrast between figure and background",
      "wide or medium composition, subject off-centre, real negative space",
      "clean flat color fields, no gradients, no painterly texture",
    ].join(", "),
    negatives: [
      "no photorealistic humans",
      "no photorealistic textures",
      "no 3D render",
      "no soft airbrushed shading",
      "no muted or desaturated palette",
      "no centered symmetrical hero shot",
      "no text, no letters, no captions, no logos, no watermark",
    ].join(", "),
  },
  // true_story needs to read as a specific real incident, not a cartoon --
  // but full photorealism invites an uncanny-valley/deepfake reading this
  // pipeline explicitly avoids (RFC 0008 decision 2). A courtroom-sketch-
  // artist register threads that: recognizably human, grounded, restrained,
  // but still visibly hand-drawn.
  documentary_sketch: {
    houseStyle: [
      "restrained charcoal and graphite reportage sketch, loose confident cross-hatching, single consistent art style across a series",
      "human figures have real proportions and readable individual likeness rendered as sketch marks, not smooth photoreal skin -- courtroom-sketch-artist register",
      "environments and objects are rendered with grounded, observational detail -- real specific settings, not generic backdrops",
      "muted grayscale-leaning palette with one restrained accent color per scene at most",
      "documentary framing -- eye-level, slightly off-centre, as if observed rather than staged",
      "visible charcoal grain and paper tooth texture uniformly across the image",
    ].join(", "),
    negatives: [
      "no photorealistic render",
      "no smooth airbrushed skin",
      "no glossy 3D render",
      "no bright saturated color",
      "no cartoon proportions, no faceless figures",
      "no centered symmetrical hero shot",
      "no text, no letters, no captions, no logos, no watermark",
    ].join(", "),
  },
  // short_story favors literary whimsy over parable starkness or drama
  // punch -- a softer, more painterly register signals "story", the way a
  // hardback storybook illustration does, distinct from both ink_wash's
  // starkness and flat_comic's boldness.
  watercolor_storybook: {
    houseStyle: [
      "soft watercolor storybook illustration, gentle visible brushwork, single consistent art style across a series",
      "human figures are simplified and painterly with softly suggested faces -- gentle, warm, not sharply detailed",
      "environments and objects carry soft painterly detail and visible color bleed at edges",
      "warm pastel palette -- dusty blues, warm creams, soft rose, muted greens -- gentle contrast, no harsh saturation",
      "wide, breathing composition, subject off-centre, generous negative space",
      "visible watercolor paper texture and soft pigment bloom uniformly across the image",
    ].join(", "),
    negatives: [
      "no photorealistic humans",
      "no bold black outlines",
      "no flat vector shapes",
      "no glossy 3D render",
      "no harsh saturated color",
      "no centered symmetrical hero shot",
      "no text, no letters, no captions, no logos, no watermark",
    ].join(", "),
  },
  // Not a genre default -- an explicit pick for suspense/thriller-leaning
  // content (a dark true_story, a tense drama) where even documentary_sketch
  // or flat_comic read too gentle for the material.
  noir_charcoal: {
    houseStyle: [
      "high-contrast noir charcoal and ink illustration, dramatic chiaroscuro shadow, single consistent art style across a series",
      "human figures are rendered mostly in silhouette or heavy shadow, with only selective detail catching the light",
      "environments and objects are simplified into strong shapes defined by light and shadow rather than line",
      "near-monochrome palette -- charcoal black, cold gray, a single muted accent color reserved for emphasis",
      "tight, tense composition, subject often off-centre or partially obscured",
      "visible charcoal texture and heavy grain uniformly across the image",
    ].join(", "),
    negatives: [
      "no photorealistic humans",
      "no bright even lighting",
      "no flat cheerful color",
      "no glossy 3D render",
      "no whimsical or cute proportions",
      "no centered symmetrical hero shot",
      "no text, no letters, no captions, no logos, no watermark",
    ].join(", "),
  },
};

function clean(value: unknown, max = 320): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

export function buildIllustratedPrompt(imagePrompt: string, style: ImageStyle = DEFAULT_STYLE): string {
  const bundle = STYLE_BUNDLES[style] ?? STYLE_BUNDLES[DEFAULT_STYLE];
  return [
    `Subject: ${clean(imagePrompt)}.`,
    `Style: ${bundle.houseStyle}.`,
    `Exclude: ${bundle.negatives}.`,
  ].join(" ");
}

function stableSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) & 0x7fffffff;
}

async function generateOne(
  provider: ReferenceCapableProvider,
  prompt: string,
  seed: number,
  reference: GeneratedImage | undefined,
): Promise<GeneratedImage> {
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

/**
 * generateOne, plus the same two vision QA passes hybrid_visual_assets ran
 * (see that file's now-deleted generatePackWithVisionQa): reject baked-in
 * text/lettering, and reject imagery that actively contradicts its own
 * narration. Both checks fail open (pass) on QA-infrastructure problems so a
 * QA outage never blocks generation.
 *
 * Up to two full attempts, covering EITHER failure mode -- a raw provider
 * exception (rate limit, transient network error, a safety-checker block)
 * or a vision QA flag. Real production case: scene 0 (the literal first
 * scene, with no reference image yet to fall back on) hit a bare provider
 * exception on its only attempt and went straight to a blank placeholder --
 * the vision-QA retry never even applied, because the failure never reached
 * flags() at all.
 */
async function generateWithVisionQa(
  provider: ReferenceCapableProvider,
  prompt: string,
  seed: number,
  reference: GeneratedImage | undefined,
  logger: WorkerContext["logger"],
  sceneIndex: number,
  narration: string,
): Promise<GeneratedImage> {
  const flags = async (image: GeneratedImage): Promise<string[]> => {
    const [textResult, semanticResult] = await Promise.all([
      checkGeneratedImageForText(image),
      narration.trim() ? checkGeneratedImageMatchesNarration(image, narration) : Promise.resolve(null),
    ]);
    const out: string[] = [];
    if (textResult?.hasVisibleText) out.push(`visible text: ${textResult.reason}`);
    if (semanticResult?.contradictsNarration) out.push(`contradicts narration: ${semanticResult.reason}`);
    return out;
  };

  const MAX_ATTEMPTS = 2;
  let lastError = new Error("unreachable");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptSeed = attempt === 0 ? seed : (seed + attempt) & 0x7fffffff;
    try {
      const image = await generateOne(provider, prompt, attemptSeed, reference);
      const failed = await flags(image);
      if (failed.length === 0) return image;
      lastError = new Error(`generated image fails vision QA: ${failed.join("; ")}`);
      logger.warn(
        `[illustrated_scene_assets] scene ${sceneIndex}: attempt ${attempt + 1}/${MAX_ATTEMPTS} failed vision QA ` +
          `(${failed.join("; ")})${attempt + 1 < MAX_ATTEMPTS ? "; regenerating" : ""}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        `[illustrated_scene_assets] scene ${sceneIndex}: attempt ${attempt + 1}/${MAX_ATTEMPTS} generation failed ` +
          `(${lastError.message})${attempt + 1 < MAX_ATTEMPTS ? "; regenerating" : ""}`,
      );
    }
  }
  throw lastError;
}

export function makeIllustratedSceneAssetsWorker(opts: IllustratedSceneAssetsWorkerOptions = {}): WorkerDef {
  return {
    name: "illustrated_scene_assets",
    kind: "worker",
    version: opts.version ?? "4",
    consumes: [
      { schema_id: "episode_direction", range: "^1", as: "direction" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "intent", range: "^1", as: "intent" },
    ],
    produces: "asset_manifest",
    produces_version: "1.7.0",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const scenes = (inputs["direction"]!.payload as { scenes: DirectionScene[] }).scenes;
      const scripts = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const intent = inputs["intent"]!.payload as IntentPayload;
      const style: ImageStyle = intent.image_style && intent.image_style in STYLE_BUNDLES ? intent.image_style : DEFAULT_STYLE;
      const narrationBy = new Map(scripts.map((s) => [s.scene_index, clean(s.narration, 400)]));
      const outroSceneIndex = scripts.find((s) => s.is_outro === true)?.scene_index;
      const configured = ctx.media.images as ReferenceCapableProvider | undefined;
      const provider = configured && !configured.id.startsWith("fake/") ? configured : undefined;
      const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);

      // Retry-aware reuse (real production case: a QA-triggered regeneration
      // after scene 0 came back a bare placeholder). ctx.priorArtifact is
      // this same worker's own most recent successful manifest for this run
      // (see runner.ts) -- set only when GraphExecutor.regenerateNode() has
      // forced this node to run again. A scene that already has real content
      // (source "primary" or "fallback") is left untouched: no new spend, no
      // risk of re-rolling a scene that was already fine. Only scenes that
      // were true blank placeholders get attempted below.
      interface PriorScene { scene_index?: number; source?: string; image_uri?: string; prompt?: string; template_data?: string }
      const priorScenes = new Map<number, PriorScene>(
        ((ctx.priorArtifact?.payload as { scenes?: PriorScene[] } | undefined)?.scenes ?? [])
          .filter((s): s is PriorScene & { scene_index: number } => typeof s.scene_index === "number")
          .map((s) => [s.scene_index, s]),
      );

      const blobs: BlobRef[] = [];
      const manifestScenes: Array<Record<string, unknown>> = [];
      let referenceImage: GeneratedImage | undefined;
      let degraded = 0;

      // Give a regenerated scene real reference continuity, which the true
      // first-attempt edge case (scene 0 failing with no reference yet)
      // never had -- seed it from a reused scene's real content before the
      // loop, rather than leaving the retry to start from a blank slate too.
      for (const prior of priorScenes.values()) {
        if (prior.source !== "primary" || !prior.image_uri) continue;
        try {
          referenceImage = { bytes: await ctx.blobs.get(prior.image_uri), media_type: "image/png" };
        } catch {
          // Blob no longer on disk; fall through and generate without one.
        }
        break;
      }

      for (const scene of ordered) {
        const prior = priorScenes.get(scene.scene_index);
        if (prior && prior.source !== "placeholder" && prior.image_uri) {
          manifestScenes.push({
            scene_index: scene.scene_index,
            source: prior.source,
            image_uri: prior.image_uri,
            prompt: prior.prompt ?? buildIllustratedPrompt(scene.image_prompt, style),
            template_data: prior.template_data ?? JSON.stringify({ camera_move: scene.camera_move }),
          });
          if (prior.source === "fallback") degraded++;
          continue;
        }
        const prompt = buildIllustratedPrompt(scene.image_prompt, style);
        const seed = stableSeed(prompt);
        // The outro scene needs its CTA to actually appear on screen, not
        // just be spoken -- render.ts/compose.ts already route an is_outro
        // scene with no template_category to compose.js's KineticText card
        // (a real word-by-word reveal with an accent-highlighted last word),
        // but that card reads its text from template_data.line, which
        // nothing here set before this. Confirmed live: the CTA was
        // audio-only, no on-screen text at all. narration_script_writer
        // copies the story's outro_line into this scene's narration
        // verbatim, so it's exactly the right text to reuse.
        const isOutro = scene.scene_index === outroSceneIndex;
        const templateData = JSON.stringify({
          camera_move: scene.camera_move,
          ...(scene.on_screen_label ? { on_screen_label: scene.on_screen_label } : {}),
          ...(isOutro ? { line: narrationBy.get(scene.scene_index) ?? "" } : {}),
        });

        if (!provider) {
          manifestScenes.push({ scene_index: scene.scene_index, source: "placeholder", prompt, template_data: templateData });
          degraded++;
          continue;
        }

        try {
          const image = await generateWithVisionQa(
            provider, prompt, seed, referenceImage, ctx.logger, scene.scene_index, narrationBy.get(scene.scene_index) ?? "",
          );
          if (!referenceImage) referenceImage = image;
          const ref = await ctx.blobs.put(image.bytes, { role: "image", media_type: image.media_type });
          blobs.push(ref);
          manifestScenes.push({ scene_index: scene.scene_index, source: "primary", image_uri: ref.uri, prompt, template_data: templateData });
        } catch (error) {
          // A bare "placeholder" scene has no image_uri at all, so long-compose
          // falls back to its own generic dark gradient still (designed as a
          // backdrop behind motion-graphics text/diagrams, not as 8+ seconds
          // of standalone content) -- confirmed live, it reads as a plain
          // black screen for the whole scene. Reusing the episode's own
          // reference image instead keeps something on-style and coherent on
          // screen; a repeated shot reads as an intentional visual callback
          // in a hand-drawn format, not as a bug. Only the true edge case of
          // the FIRST scene failing (no reference generated yet) still has to
          // fall through to the placeholder -- there is nothing else on-style
          // to show yet.
          const message = error instanceof Error ? error.message : String(error);
          if (referenceImage) {
            ctx.logger.warn(`[illustrated_scene_assets] scene ${scene.scene_index} generation failed; reusing the episode's reference image instead of a blank placeholder: ${message}`);
            const ref = await ctx.blobs.put(referenceImage.bytes, { role: "image", media_type: referenceImage.media_type });
            blobs.push(ref);
            manifestScenes.push({ scene_index: scene.scene_index, source: "fallback", image_uri: ref.uri, prompt, template_data: templateData });
          } else {
            ctx.logger.warn(`[illustrated_scene_assets] scene ${scene.scene_index} generation failed; degrading to placeholder: ${message}`);
            manifestScenes.push({ scene_index: scene.scene_index, source: "placeholder", prompt, template_data: templateData });
          }
          degraded++;
        }
      }

      const first = manifestScenes.find((s) => s["scene_index"] === 0);
      if (!first || !(first["image_uri"] || first["source"] === "placeholder")) {
        throw new Error("illustrated visual invariant failed: literal scene 0 has no renderable visual");
      }

      return { payload: { scenes: manifestScenes, degraded_count: degraded }, blobs };
    },
  };
}
