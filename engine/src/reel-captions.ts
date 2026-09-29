/**
 * Per-platform Reel captions (operator 2026-09-29): "proper and custom
 * captions/tags for each platform... clickbait captions/titles" -- the first
 * Facebook post reused the long YouTube description and read like one.
 *
 * One fast-model call writes a short clickbait caption + hashtags per
 * platform; each is checked here (length, hashtag count, honesty: no invented
 * stats, no "dark psychology", no like/subscribe). A platform whose caption
 * fails -- or a failed model call -- gets a short title-led caption with
 * hashtags instead. Never the long description.
 */

import type { ModelProvider } from "./provider.ts";
import type { PromptStore } from "./prompts.ts";

export const REEL_CAPTIONS_PROMPT = "reel_captions@1";
export type CaptionPlatform = "facebook" | "instagram";
const PLATFORMS: CaptionPlatform[] = ["facebook", "instagram"];

const RULES: Record<CaptionPlatform, { maxChars: number; minTags: number; maxTags: number }> = {
  facebook: { maxChars: 200, minTags: 2, maxTags: 3 },
  instagram: { maxChars: 600, minTags: 5, maxTags: 10 },
};

const PLATFORM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["caption", "hashtags"],
  properties: { caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
} as const;

export const REEL_CAPTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facebook", "instagram"],
  properties: { facebook: PLATFORM_SCHEMA, instagram: PLATFORM_SCHEMA },
} as const;

const cleanTags = (tags: string[]) =>
  [...new Set(tags.map((t) => t.replace(/[^\p{L}\p{N}]+/gu, "")).filter((t) => t.length > 1))];

/** What is wrong with one platform's caption; empty = usable. */
export function captionProblems(platform: CaptionPlatform, caption: string, hashtags: string[]): string[] {
  const rule = RULES[platform];
  const text = caption.trim();
  const problems: string[] = [];
  if (text.length < 10 || text.length > rule.maxChars) problems.push(`caption must be 10-${rule.maxChars} characters (is ${text.length})`);
  if (platform === "instagram" && (text.split("\n")[0] ?? "").length > 125) problems.push("first line must be under 125 characters");
  if (/#\w/.test(text)) problems.push("hashtags belong in the array, not the caption");
  const tags = cleanTags(hashtags);
  if (tags.length < rule.minTags || tags.length > rule.maxTags) problems.push(`needs ${rule.minTags}-${rule.maxTags} hashtags (has ${tags.length})`);
  if (/\d+(\.\d+)?\s?%|\bpercent\b/i.test(text)) problems.push("no percentages or statistics");
  if (/\bdark psychology\b|\bmanipulat/i.test(text)) problems.push("no 'dark psychology' or manipulation framing");
  if (/\bsubscribe\b|\blike and (follow|share)\b/i.test(text)) problems.push("no like/subscribe ask");
  return problems;
}

export function assembleCaption(caption: string, hashtags: string[]): string {
  const tags = cleanTags(hashtags).map((t) => `#${t}`);
  return tags.length ? `${caption.trim()}\n\n${tags.join(" ")}` : caption.trim();
}

/** Short, title-led caption for when the model's is unusable. */
export function fallbackCaption(platform: CaptionPlatform, title: string, seoTags: string[] = []): string {
  const rule = RULES[platform];
  const base = platform === "instagram" ? ["psychology", "philosophy", "selfimprovement", "mindset", "quietsignal"] : ["psychology", "philosophy"];
  const topical = cleanTags(seoTags).slice(0, rule.maxTags - base.length);
  return assembleCaption(title, [...topical, ...base].slice(0, rule.maxTags));
}

export async function reelCaptions(
  input: { title: string; hook: string; script: string; seoTags?: string[] },
  deps: { provider: ModelProvider; prompts: PromptStore; log?: (message: string) => void },
): Promise<Record<CaptionPlatform, string>> {
  const out = Object.fromEntries(PLATFORMS.map((p) => [p, fallbackCaption(p, input.title, input.seoTags)])) as Record<CaptionPlatform, string>;
  try {
    const prompt = deps.prompts.render(REEL_CAPTIONS_PROMPT, { title: input.title, hook: input.hook, script: input.script });
    const result = await deps.provider.complete({
      prompt,
      outputSchema: REEL_CAPTIONS_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 1500,
      effort: "low",
    });
    const value = (result.value ?? {}) as Partial<Record<CaptionPlatform, { caption?: unknown; hashtags?: unknown }>>;
    for (const platform of PLATFORMS) {
      const caption = String(value[platform]?.caption ?? "");
      const raw = value[platform]?.hashtags;
      const hashtags = Array.isArray(raw) ? raw.map(String) : [];
      const problems = captionProblems(platform, caption, hashtags);
      if (problems.length === 0) out[platform] = assembleCaption(caption, hashtags);
      else deps.log?.(`[reel-captions] ${platform} caption rejected (${problems.join("; ")}); using the title`);
    }
  } catch (err) {
    deps.log?.(`[reel-captions] caption model failed (${err instanceof Error ? err.message : String(err)}); using the title`);
  }
  return out;
}
