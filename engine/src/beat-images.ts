/**
 * Per-beat still images for the editor (operator 2026-09-30, at the editor's
 * request): one portrait image per script beat, generated with OpenAI's
 * gpt-image-1-mini at medium quality (~$0.015 each, so ~$0.10 per Short) and
 * dropped into a `beats/` subfolder of the episode's Drive folder.
 *
 * Council review before building: best-effort and OFF the critical path. A
 * separate scheduler job, after the editor package is uploaded -- a failure
 * here never blocks or fails the hand-off. At most MAX_BEAT_IMAGES per run,
 * generated once (a crashed pass is never retried: that could pay twice).
 * One image per beat rather than one grid sheet: a grid tile is ~512 px,
 * far below a 1080x1920 frame. Each prompt is written to prompts.md so the
 * editor can regenerate a single beat by hand.
 *
 * Style (operator 2026-09-30): stickman figures with clear, expressive
 * facial expressions -- the emotion of each beat carried by the face.
 */

import type { DriveExchange } from "./providers/drive.ts";
import type { ModelProvider } from "./provider.ts";
import type { PromptStore } from "./prompts.ts";
import { ffmpegTransform } from "./ffmpeg-file.ts";

export const BEAT_IMAGES_PROMPT = "beat_images@4";
export const BEAT_IMAGE_MODEL = "gpt-image-1-mini";
/**
 * The scene is drawn square and laid into the Short's 1080x1920 frame with a
 * clean caption area on top (operator 2026-10-03: the editor had no room for
 * big captions; chose this layout over a cropped full frame after a test).
 */
export const BEAT_IMAGE_SIZE = "1024x1024";
/** What the editor gets: exactly the Short's frame. */
export const BEAT_FRAME = { width: 1080, height: 1920 } as const;
/** Clean area at the top for captions, filled with the scene's own top colour. */
export const CAPTION_SPACE_PX = 840;
/** The scene's top edge fades into the caption area over this many px (no visible seam). */
export const CAPTION_BLEND_PX = 60;
export const BEAT_IMAGE_QUALITY = "medium";
/**
 * Images per Short, by length (operator 2026-10-11: "make the default images
 * 12-15 depending on the length" -- for every Short, written by the AI or by
 * hand). One image per ~SECONDS_PER_IMAGE of narration, never fewer than 12
 * or more than 15 (~$0.20-0.26 per Short). Images are planned over the
 * narration's time, not per scene: a long beat gets several images, a run of
 * short lines shares one, and the closing line reuses the hook's.
 */
export const MIN_BEAT_IMAGES = 12;
export const MAX_BEAT_IMAGES = 15;
export const SECONDS_PER_IMAGE = 5.5;
/** Without recorded narration durations, words are timed at this speaking rate. */
export const WORDS_PER_SEC = 2.6;
/** No image for fewer words than this (~2 s): a very short script gets fewer images. */
export const MIN_WORDS_PER_IMAGE = 5;
/** Before 2026-10-11 the first 10 beats got one image each; folders made then have no beats.json. */
export const LEGACY_MAX_BEAT_IMAGES = 10;
/** Which narration each image covers, written next to the images for the automatic edit. */
export const BEATS_MANIFEST = "beats.json";
/** OpenAI list price for one medium 1024x1536 gpt-image-1-mini image (2026-09). */
export const EST_COST_PER_IMAGE_USD = 0.017; // + two small reference images as input
export const BEATS_FOLDER = "beats";

/** Fixed art direction, prepended to every beat so the Short looks like one piece. */
/**
 * The Quiet Signal series look (operator 2026-10-02: "make this repeated so
 * the channel has a known pattern and people recognize it"). Fixed for every
 * image of every Short: one main character, one supporting-cast look, one
 * palette, one line style. The two reference images in assets/series are
 * sent with every request -- a text description alone drifted (hoodie shade,
 * other people sometimes drawn as realistic humans).
 */
export const YOU =
  "a white stick figure with a perfectly round white head, thick black outline, simple black dot eyes and expressive eyebrows, " +
  "wearing a mustard-yellow (#F2B630) hoodie with the hood down and a small white emblem of three curved signal arcs on the chest, dark charcoal trousers and dark shoes";
export const OTHERS =
  "stick figures with a perfectly round LIGHT-GREY head (no hair, no ears, no nose), simple dot eyes and eyebrows, in plain teal or navy clothing";
export const STYLE =
  "Vertical illustration in the Quiet Signal series style: polished comic-stickman, thick clean black outlines, flat bright high-contrast colours " +
  "from one palette (mustard #F2B630, teal #2EC4B6, coral #FF6B6B, soft cream #FFF4E0, deep navy #22313F, light grey #D9DEE3). " +
  `When the scene says "you", that is ${YOU} -- exactly the first reference image. ` +
  "Named characters are drawn in the same series style (round head, thick outline, flat colours) but with the hair and clothing given for them, so their gender and identity read at a glance -- never bald, never in the mustard hoodie. " +
  `Unnamed background people are ${OTHERS} -- like the second reference image. Never realistic humans. ` +
  "Readable cartoon faces with clear eyebrows, eyes and mouth, and natural expressive body language; small emotion marks (sweat drops, blush, motion lines) only where they fit. " +
  "Keep each emotion exactly as described -- subtle means subtle, not angry. " +
  "A detailed, recognisable setting full of the specific props described, drawn in the same flat style. " +
  "Square composition. The TOP QUARTER is plain, empty background only -- a flat wall or sky in one colour, no objects, lamps, frames or plants, nothing touching the top edge " +
  "(captions go above it). All characters and props sit in the lower three quarters, large and central, framed from the knees up, away from the left and right edges. " +
  "Absolutely no text, letters, numbers, speech bubbles, signage, logos or watermarks.";

/** The series' fixed character references, shipped with the engine. */
export const SERIES_REFERENCE_FILES = ["you.png", "others.png"] as const;

export async function loadSeriesReferences(dir = new URL("../assets/series/", import.meta.url)): Promise<Uint8Array[]> {
  const { readFile } = await import("node:fs/promises");
  return Promise.all(SERIES_REFERENCE_FILES.map(async (f) => new Uint8Array(await readFile(new URL(f, dir)))));
}

export interface BeatScene {
  scene_index: number;
  narration: string;
  point?: string;
  is_outro?: boolean;
}

export interface BeatPlan {
  /** Scene the image's narration starts in. */
  scene_index: number;
  file: string;
  narration: string;
  description: string;
  /** The narration words this image covers: [start_word, end_word) over the narrated scenes in order. */
  start_word: number;
  end_word: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cast", "images"],
  properties: {
    cast: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "gender", "look"],
        properties: { name: { type: "string" }, gender: { type: "string", enum: ["woman", "man", "unspecified"] }, look: { type: "string" } },
      },
    },
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description"],
        properties: { id: { type: "integer" }, description: { type: "string" } },
      },
    },
  },
} as const;

/**
 * The closing line: a scene marked is_outro, or the spoken CTA that
 * cta.ts appends (point "[cta] ..." -- it is not marked is_outro).
 */
export function isClosingScene(s: BeatScene): boolean {
  return !!s.is_outro || /^\[cta\]/i.test(s.point ?? "");
}

/** The beats worth an image: narrated, not the closing follow line, in order. */
export function selectBeats(scenes: BeatScene[], cap = Infinity): BeatScene[] {
  return scenes
    .filter((s) => !isClosingScene(s) && s.narration?.trim())
    .sort((a, b) => a.scene_index - b.scene_index)
    .slice(0, cap);
}

export function narrationWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** How many images a Short of this length gets. */
export function imageCount(totalSec: number): number {
  return Math.min(MAX_BEAT_IMAGES, Math.max(MIN_BEAT_IMAGES, Math.round(totalSec / SECONDS_PER_IMAGE)));
}

export interface ImageSlot { scene_index: number; start_word: number; end_word: number; text: string }

/**
 * Split the narration (closing line excluded) into imageCount() stretches of
 * about equal speaking time. The hook -- the first beat -- is always its own
 * image. Every other cut moves to the best break near its ideal time -- end
 * of a beat, else of a sentence, else a clause -- so an image rarely changes
 * mid-thought.
 */
export function planImageSlots(scenes: BeatScene[], durations?: Map<number, number>): ImageSlot[] {
  const beats = selectBeats(scenes);
  const words: Array<{ text: string; scene: number; sec: number; boundary: number }> = [];
  for (const b of beats) {
    const w = narrationWords(b.narration);
    const dur = durations?.get(b.scene_index);
    const per = dur && dur > 0 ? dur / w.length : 1 / WORDS_PER_SEC;
    w.forEach((text, i) => words.push({
      text, scene: b.scene_index, sec: per,
      // How good a cut AFTER this word is: 3 end of beat, 2 sentence, 1 clause.
      boundary: i === w.length - 1 ? 3 : /[.!?]["')\]]*$/.test(text) ? 2 : /[,;:—]["')\]]*$/.test(text) ? 1 : 0,
    }));
  }
  if (words.length === 0) return [];
  const endAt: number[] = [];
  words.reduce((t, w, i) => (endAt[i] = t + w.sec), 0);
  const total = endAt.at(-1)!;
  const n = Math.max(1, Math.min(imageCount(total), Math.floor(words.length / MIN_WORDS_PER_IMAGE)));
  const hookEnd = narrationWords(beats[0]!.narration).length;
  const cuts: number[] = [];
  if (n > 1 && hookEnd < words.length) {
    cuts.push(hookEnd);
    const t0 = endAt[hookEnd - 1]!, span = total - t0, rest = n - 1;
    const window = (span / rest) * 0.4;
    for (let k = 1; k < rest; k++) {
      const ideal = t0 + (span * k) / rest;
      let best = -1, bestScore = -Infinity;
      for (let i = hookEnd; i < words.length - 1; i++) {
        const d = Math.abs(endAt[i]! - ideal);
        if (d > window) continue;
        const score = words[i]!.boundary * window * 0.5 - d;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) best = endAt.findIndex((t) => t >= ideal);
      const cut = best + 1;
      if (cut > cuts.at(-1)! && cut < words.length) cuts.push(cut);
    }
  }
  const bounds = [0, ...cuts, words.length];
  const slots: ImageSlot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [from, to] = [bounds[i]!, bounds[i + 1]!];
    if (to > from) slots.push({ scene_index: words[from]!.scene, start_word: from, end_word: to, text: words.slice(from, to).map((w) => w.text).join(" ") });
  }
  return slots;
}

function slug(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 5).join("-") || "beat";
}

function firstSentence(text: string): string {
  return (text.trim().split(/(?<=[.!?])\s+/)[0] ?? text).slice(0, 300);
}

/** Without a usable planner answer, draw the beat's own words as a scene. */
export function fallbackDescription(scene: BeatScene): string {
  return `A stick figure acting out this everyday moment, its facial expression and body language clearly showing how it feels: "${firstSentence(scene.point || scene.narration)}"`;
}

/** One image description per beat, from the fast model, with a per-beat fallback. */
/**
 * A person the story is about, with ONE fixed look (operator 2026-10-05: a
 * script about "Emma" came out as the series' bald hoodie figure -- gender
 * and identity must read at a glance, and stay the same across beats).
 */
export interface CastMember { name: string; gender: "woman" | "man" | "unspecified"; look: string }

function validCast(raw: unknown): CastMember[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const m = c as Partial<CastMember>;
    const name = String(m?.name ?? "").trim(), look = String(m?.look ?? "").trim();
    const gender = m?.gender === "woman" || m?.gender === "man" ? m.gender : "unspecified";
    // The mustard hoodie is "you"'s signature -- a cast member wearing it would read as "you".
    if (!name || name.length > 60 || look.length < 8 || look.length > 240 || /mustard/i.test(look)) return [];
    return [{ name, gender, look }];
  });
}

/**
 * The fixed look of every cast member named in a scene, appended to it so the
 * image model draws the same person -- same hair, same clothes, clear gender
 * -- in every beat, whatever wording the planner used in that scene.
 */
export function castNote(description: string, cast: CastMember[]): string {
  const present = cast.filter((c) => new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(description));
  if (present.length === 0) return "";
  return `\nCharacters in this scene (draw exactly as described, same in every image): ${present
    .map((c) => `${c.name}${c.gender === "unspecified" ? "" : ` (a ${c.gender})`} -- round-headed series figure with ${c.look}`)
    .join("; ")}.`;
}

export async function planBeats(
  title: string,
  scenes: BeatScene[],
  deps: { provider: ModelProvider | null; prompts: PromptStore; log?: (m: string) => void; durations?: Map<number, number> },
): Promise<BeatPlan[]> {
  const slots = planImageSlots(scenes, deps.durations);
  const byId = new Map<number, string>();
  if (deps.provider && slots.length) {
    try {
      const prompt = deps.prompts.render(BEAT_IMAGES_PROMPT, {
        title,
        moments: slots.map((m, i) => `${i + 1}: ${m.text}`).join("\n"),
      });
      const res = await deps.provider.complete({ prompt, outputSchema: SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 9000, effort: "low" });
      const value = res.value as { cast?: unknown[]; images?: Array<{ id?: unknown; description?: unknown }> };
      const cast = validCast(value?.cast);
      for (const item of value?.images ?? []) {
        const d = String(item.description ?? "").trim();
        if (typeof item.id === "number" && d.length >= 20 && d.length <= 2000) byId.set(item.id, `${d}${castNote(d, cast)}`);
      }
    } catch (err) {
      deps.log?.(`[beat-images] planner failed (${err instanceof Error ? err.message : String(err)}); using the narration`);
    }
  }
  return slots.map((m, i) => ({
    scene_index: m.scene_index,
    file: `${String(i + 1).padStart(2, "0")}-${i === 0 ? "hook" : slug(m.text)}.png`,
    narration: m.text,
    description: byId.get(i + 1) ?? fallbackDescription({ scene_index: m.scene_index, narration: m.text }),
    start_word: m.start_word,
    end_word: m.end_word,
  }));
}

/**
 * beats.json: which narration each image covers, so the automatic edit
 * (auto-edit.ts) shows every image exactly while its words are spoken.
 */
export function beatsManifest(scenes: BeatScene[], plans: BeatPlan[]): string {
  return JSON.stringify({
    version: 1,
    scenes: selectBeats(scenes).map((s) => ({ scene_index: s.scene_index, words: narrationWords(s.narration).length })),
    images: plans.map((p) => ({ file: p.file, scene_index: p.scene_index, start_word: p.start_word, end_word: p.end_word })),
  }, null, 2);
}

export function fullPrompt(description: string): string {
  return `${STYLE}\n\nReference images (line style and proportions): the first is "you" -- only when the scene says "you"; the second is an unnamed background person.\n\nScene: ${description}`;
}

/** One image from the OpenAI Images API. The key never appears in an error. */
export async function generateBeatImage(
  prompt: string,
  opts: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string; references?: Uint8Array[] },
): Promise<Uint8Array> {
  const base = opts.baseUrl ?? "https://api.openai.com/v1";
  const refs = opts.references ?? [];
  // With references: /images/edits draws the scene using them as the
  // character sheet (verified with gpt-image-1-mini 2026-10-02). Without:
  // plain generation.
  let request: RequestInit;
  if (refs.length > 0) {
    const form = new FormData();
    form.append("model", BEAT_IMAGE_MODEL);
    form.append("prompt", prompt);
    refs.forEach((r, i) => form.append("image[]", new Blob([r], { type: "image/png" }), `reference-${i + 1}.png`));
    form.append("size", BEAT_IMAGE_SIZE);
    form.append("quality", BEAT_IMAGE_QUALITY);
    form.append("n", "1");
    request = { method: "POST", headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form };
  } else {
    request = {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: BEAT_IMAGE_MODEL, prompt, size: BEAT_IMAGE_SIZE, quality: BEAT_IMAGE_QUALITY, n: 1, output_format: "png" }),
    };
  }
  const res = await (opts.fetchImpl ?? fetch)(`${base}/images/${refs.length > 0 ? "edits" : "generations"}`, {
    ...request,
    signal: AbortSignal.timeout(240_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string }>; error?: { message?: string; code?: string } };
  if (!res.ok || !body.data?.[0]?.b64_json) {
    const detail = (body.error?.message ?? `HTTP ${res.status}`).split(opts.apiKey).join("[REDACTED]");
    throw new Error(`image generation failed (${res.status}${body.error?.code ? ` ${body.error.code}` : ""}): ${detail.slice(0, 300)}`);
  }
  return new Uint8Array(Buffer.from(body.data[0].b64_json, "base64"));
}

/** ffmpeg arguments: average colour of the scene's top rows, as 3 raw RGB bytes. */
export function topColourArgs(input: string, output: string): string[] {
  return ["-v", "error", "-y", "-i", input, "-vf", "crop=iw:12:0:0,scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", output];
}

/**
 * ffmpeg arguments: square scene (scaled to 1080 wide) at the bottom of the
 * 1080x1920 frame; the CAPTION_SPACE_PX above it is filled with `hex`, the
 * scene's own top colour, and the scene's top CAPTION_BLEND_PX fade into it.
 */
export function shortFrameArgs(input: string, output: string, hex: string): string[] {
  const { width, height } = BEAT_FRAME;
  const b = CAPTION_BLEND_PX;
  const filter =
    `[0:v]scale=${width}:${width}:flags=lanczos,format=rgba,` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(Y,${b}),255*Y/${b},255)'[scene];` +
    `color=c=0x${hex}:s=${width}x${height}:d=1[bg];[bg][scene]overlay=0:${CAPTION_SPACE_PX},format=rgb24`;
  return ["-v", "error", "-y", "-i", input, "-filter_complex", filter, "-frames:v", "1", output];
}

/** Lay one generated scene into the Short's frame with the caption area; a failure says so plainly. */
export async function fitToShortFrame(png: Uint8Array, ffmpeg?: string): Promise<Uint8Array> {
  const run = { timeoutMs: 60_000, ...(ffmpeg ? { ffmpeg } : {}) };
  try {
    const rgb = await ffmpegTransform(png, { inName: "in.png", outName: "top.rgb", args: topColourArgs, ...run });
    const hex = [...rgb.subarray(0, 3)].map((v) => v.toString(16).padStart(2, "0")).join("") || "fff4e0";
    return await ffmpegTransform(png, { inName: "in.png", outName: "out.png", args: (i, o) => shortFrameArgs(i, o, hex), ...run });
  } catch (err) {
    throw new Error(`frame crop failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function promptsMarkdown(title: string, plans: BeatPlan[], failed: string[]): string {
  return [
    `# Beat images — ${title}`,
    "",
    `${plans.length} images over the narration, in order (each shows the words under it), ${BEAT_FRAME.width}x${BEAT_FRAME.height} (9:16, the Short's frame), generated with ${BEAT_IMAGE_MODEL} (${BEAT_IMAGE_QUALITY} quality). Use or ignore any of them.`,
    `The top ${CAPTION_SPACE_PX} px of every image is clean -- room for big captions.`,
    "To redo one: paste its full prompt below into ChatGPT (or ask the operator) and change the Scene line.",
    ...(failed.length ? ["", `Not generated this time: ${failed.join(", ")}`] : []),
    "",
    ...plans.flatMap((p) => [
      `## ${p.file}`,
      "",
      `Narration: ${p.narration}`,
      "",
      "Prompt:",
      "",
      "```",
      fullPrompt(p.description),
      "```",
      "",
    ]),
  ].join("\n");
}

export interface DeliverResult {
  folder_id: string;
  generated: number;
  skipped_existing: number;
  failed: string[];
  estimated_cost_usd: number;
}

/**
 * Generate and upload every planned beat image into <episode>/beats/. Files
 * already there are kept (a resumed pass never pays twice). One failed beat
 * does not stop the others; if EVERY generation fails the pass throws, so the
 * caller records a failure instead of an empty success.
 */
export async function deliverBeatImages(
  input: { episodeFolderId: string; title: string; plans: BeatPlan[]; scenes?: BeatScene[] },
  deps: { drive: DriveExchange; generate: (prompt: string) => Promise<Uint8Array>; log?: (m: string) => void },
): Promise<DeliverResult> {
  const plans = input.plans.slice(0, MAX_BEAT_IMAGES);
  const existingFolder = (await deps.drive.listFiles(input.episodeFolderId))
    .find((f) => f.name === BEATS_FOLDER && f.mimeType === "application/vnd.google-apps.folder");
  const folderId = existingFolder?.id ?? await deps.drive.createFolder(BEATS_FOLDER, input.episodeFolderId);
  const present = new Set((await deps.drive.listFiles(folderId)).map((f) => f.name));

  let generated = 0, skipped = 0;
  const failed: string[] = [];
  let lastError = "";
  for (const plan of plans) {
    if (present.has(plan.file)) { skipped++; continue; }
    try {
      const bytes = await deps.generate(fullPrompt(plan.description));
      await deps.drive.uploadFile(folderId, plan.file, bytes, "image/png");
      generated++;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      failed.push(plan.file);
      deps.log?.(`[beat-images] ${plan.file}: ${lastError}`);
      // A bad key, an empty balance or a broken crop fails every further
      // beat the same way -- stop before paying for images that would be lost.
      if (/\((401|429)\b|insufficient_quota|billing|frame crop failed/i.test(lastError)) break;
    }
  }
  if (generated === 0 && skipped === 0) throw new Error(`no beat image could be generated: ${lastError || "nothing planned"}`);
  if (input.scenes && !present.has(BEATS_MANIFEST)) {
    await deps.drive.uploadFile(folderId, BEATS_MANIFEST, new TextEncoder().encode(beatsManifest(input.scenes, plans)), "application/json");
  }
  if (!present.has("prompts.md")) {
    await deps.drive.uploadFile(folderId, "prompts.md", new TextEncoder().encode(promptsMarkdown(input.title, plans, failed)), "text/markdown");
  }
  return { folder_id: folderId, generated, skipped_existing: skipped, failed, estimated_cost_usd: +(generated * EST_COST_PER_IMAGE_USD).toFixed(3) };
}
