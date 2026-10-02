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

export const BEAT_IMAGES_PROMPT = "beat_images@1";
export const BEAT_IMAGE_MODEL = "gpt-image-1-mini";
/** What the model can make: its tallest size is 2:3, there is no 9:16. */
export const BEAT_IMAGE_SIZE = "1024x1536";
/**
 * What the editor gets (operator 2026-10-02: "wrong size"): exactly the
 * Short's 1080x1920 frame -- scaled to 1280x1920, centre-cropped to 1080
 * wide, so ~8% of each side is lost and STYLE keeps figures away from it.
 */
export const BEAT_FRAME = { width: 1080, height: 1920 } as const;
export const BEAT_IMAGE_QUALITY = "medium";
/** Hard cap per run -- the cost bound, whatever the script length. */
export const MAX_BEAT_IMAGES = 10; // hook + up to 9 beats (short_script_writer@2); ~$0.17 per Short
/** OpenAI list price for one medium 1024x1536 gpt-image-1-mini image (2026-09). */
export const EST_COST_PER_IMAGE_USD = 0.015;
export const BEATS_FOLDER = "beats";

/** Fixed art direction, prepended to every beat so the Short looks like one piece. */
export const STYLE =
  "Vertical 9:16 stickman illustration: simple black stick figures with round heads and clean, bold line work on a plain off-white background, " +
  "minimal props drawn in the same simple line style, one soft accent colour at most. " +
  "Every stick figure has a clear, expressive face (eyes, eyebrows and mouth) whose emotion reads instantly -- worried, embarrassed, relieved, surprised, calm -- " +
  "and body language that matches it. Keep the figures in the middle third, with empty space at the top and bottom for captions, " +
  "and well away from the left and right edges (the sides are cropped). " +
  "Absolutely no text, letters, numbers, speech bubbles, signage, logos or watermarks.";

export interface BeatScene {
  scene_index: number;
  narration: string;
  point?: string;
  is_outro?: boolean;
}

export interface BeatPlan {
  scene_index: number;
  file: string;
  narration: string;
  description: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["images"],
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scene_index", "description"],
        properties: { scene_index: { type: "integer" }, description: { type: "string" } },
      },
    },
  },
} as const;

/** The beats worth an image: narrated, not the closing follow line, capped. */
export function selectBeats(scenes: BeatScene[]): BeatScene[] {
  return scenes
    .filter((s) => !s.is_outro && s.narration?.trim())
    .sort((a, b) => a.scene_index - b.scene_index)
    .slice(0, MAX_BEAT_IMAGES);
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
export async function planBeats(
  title: string,
  scenes: BeatScene[],
  deps: { provider: ModelProvider | null; prompts: PromptStore; log?: (m: string) => void },
): Promise<BeatPlan[]> {
  const beats = selectBeats(scenes);
  const byIndex = new Map<number, string>();
  if (deps.provider && beats.length) {
    try {
      const prompt = deps.prompts.render(BEAT_IMAGES_PROMPT, {
        title,
        beats: beats.map((b) => `${b.scene_index}: ${b.narration.trim()}`).join("\n"),
      });
      const res = await deps.provider.complete({ prompt, outputSchema: SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 2500, effort: "low" });
      for (const item of (res.value as { images?: Array<{ scene_index?: unknown; description?: unknown }> })?.images ?? []) {
        const d = String(item.description ?? "").trim();
        if (typeof item.scene_index === "number" && d.length >= 20 && d.length <= 800) byIndex.set(item.scene_index, d);
      }
    } catch (err) {
      deps.log?.(`[beat-images] planner failed (${err instanceof Error ? err.message : String(err)}); using the narration`);
    }
  }
  return beats.map((b, i) => ({
    scene_index: b.scene_index,
    file: `${String(i + 1).padStart(2, "0")}-${i === 0 ? "hook" : slug(b.point || b.narration)}.png`,
    narration: b.narration.trim(),
    description: byIndex.get(b.scene_index) ?? fallbackDescription(b),
  }));
}

export function fullPrompt(description: string): string {
  return `${STYLE}\n\nScene: ${description}`;
}

/** One image from the OpenAI Images API. The key never appears in an error. */
export async function generateBeatImage(
  prompt: string,
  opts: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string },
): Promise<Uint8Array> {
  const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? "https://api.openai.com/v1"}/images/generations`, {
    method: "POST",
    signal: AbortSignal.timeout(240_000),
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: BEAT_IMAGE_MODEL, prompt, size: BEAT_IMAGE_SIZE, quality: BEAT_IMAGE_QUALITY, n: 1, output_format: "png" }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string }>; error?: { message?: string; code?: string } };
  if (!res.ok || !body.data?.[0]?.b64_json) {
    const detail = (body.error?.message ?? `HTTP ${res.status}`).split(opts.apiKey).join("[REDACTED]");
    throw new Error(`image generation failed (${res.status}${body.error?.code ? ` ${body.error.code}` : ""}): ${detail.slice(0, 300)}`);
  }
  return new Uint8Array(Buffer.from(body.data[0].b64_json, "base64"));
}

/** ffmpeg arguments: model image (2:3) -> exactly the Short's 1080x1920 frame. */
export function shortFrameArgs(input: string, output: string): string[] {
  const { width, height } = BEAT_FRAME;
  // Scale to the frame's height, then centre-crop the width.
  return ["-v", "error", "-y", "-i", input, "-vf", `scale=-2:${height}:flags=lanczos,crop=${width}:${height}`, "-frames:v", "1", output];
}

/** Fit one generated image to the Short's frame; a failure says so plainly. */
export async function fitToShortFrame(png: Uint8Array, ffmpeg?: string): Promise<Uint8Array> {
  try {
    return await ffmpegTransform(png, { inName: "in.png", outName: "out.png", args: shortFrameArgs, timeoutMs: 60_000, ...(ffmpeg ? { ffmpeg } : {}) });
  } catch (err) {
    throw new Error(`frame crop failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function promptsMarkdown(title: string, plans: BeatPlan[], failed: string[]): string {
  return [
    `# Beat images — ${title}`,
    "",
    `One image per beat, ${BEAT_FRAME.width}x${BEAT_FRAME.height} (9:16, the Short's frame), generated with ${BEAT_IMAGE_MODEL} (${BEAT_IMAGE_QUALITY} quality). Use or ignore any of them.`,
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
  input: { episodeFolderId: string; title: string; plans: BeatPlan[] },
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
  if (!present.has("prompts.md")) {
    await deps.drive.uploadFile(folderId, "prompts.md", new TextEncoder().encode(promptsMarkdown(input.title, plans, failed)), "text/markdown");
  }
  return { folder_id: folderId, generated, skipped_existing: skipped, failed, estimated_cost_usd: +(generated * EST_COST_PER_IMAGE_USD).toFixed(3) };
}
