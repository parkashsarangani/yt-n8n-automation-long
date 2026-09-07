// Vision QA for generated illustrations.
//
// RFC 0008 introduced a per-image "active contradiction of narration" check.
// RFC 0009 adds the two viewer-facing capabilities the illustrated format now
// depends on:
//   1) rank multiple candidates for scarce hero shots; and
//   2) review the ordered episode visually, in overlapping windows, so
//      individually-valid frames can still be rejected for repetition,
//      weak opening/payoff, style drift, continuity breaks, or AI artefacts.
//
// A separate per-image "visible text" rejection used to live here. It was
// removed: it triggered heavy regeneration loops (a numbers/scale explainer
// legitimately shows clocks, rulers, calendars) and the style negative prompts
// already discourage garbled typography. Occasional real text is tolerated.
//
// Vision scoring is DIRECT OpenAI only. The shared FreeLLMAPI auto route was
// proven to return HTTP 200 from a text-only fallback while silently dropping
// image parts, so a successful response from that proxy is not visual evidence.
// Production direct vision is guarded by a process-local read-the-number canary
// before any score is trusted. Infrastructure failures remain explicit `null`
// results rather than synthetic quality scores.

import { prepareVisionImages } from "./media/vision-image.ts";
import { ensureVisionCapability } from "./vision-capability.ts";

const TIMEOUT_MS = (() => {
  const raw = Number(process.env["IMAGE_QA_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 45_000;
})();
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface SemanticQaResult {
  contradictsNarration: boolean;
  reason: string;
}

export interface HeroRankResult {
  bestIndex: number;
  reason: string;
}

export interface VisualSequenceEntry {
  shot_id: string;
  image: { bytes: Uint8Array; media_type: string };
  narration: string;
  prompt: string;
  shot_function: string;
  hero: boolean;
}

export interface VisualSequenceReviewResult {
  scores: {
    opening_visual_strength: number;
    scene_relevance: number;
    subject_legibility: number;
    emotional_readability: number;
    shot_variety: number;
    visual_redundancy: number;
    continuity: number;
    style_consistency: number;
    ai_artifacts: number;
    payoff_visual_strength: number;
  };
  flagged_shots: string[];
  reason: string;
  reviewed_shots: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function clampScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

async function requestVisionJson(
  opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    content: Array<Record<string, unknown>>;
    maxCompletionTokens: number;
    timeoutMs?: number;
    label?: string;
  },
  fetchImpl: FetchLike,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const label = opts.label ?? "vision QA";
  try {
    const res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: opts.content }],
        max_completion_tokens: opts.maxCompletionTokens,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[image-qa] ${label} request failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      console.warn(`[image-qa] ${label} request returned no message content`);
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      console.warn(`[image-qa] ${label} response was not a JSON object`);
      return null;
    } catch {
      console.warn(`[image-qa] ${label} response was not valid JSON`);
      return null;
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${opts.timeoutMs ?? TIMEOUT_MS}ms` : "network error";
    console.warn(`[image-qa] ${label} request failed: ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askVisionMany(
  rawImages: Array<{ bytes: Uint8Array; media_type: string }>,
  instruction: string,
  fetchImpl: FetchLike,
  maxCompletionTokens = 500,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<Record<string, unknown> | null> {
  if (rawImages.length === 0) return null;
  const images = await prepareVisionImages(rawImages);

  const content: Array<Record<string, unknown>> = [{ type: "text", text: instruction }];
  for (const image of images) {
    const dataUri = `data:${image.media_type};base64,${base64FromBytes(image.bytes)}`;
    content.push({ type: "image_url", image_url: { url: dataUri, detail: "low" } });
  }

  const directApiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!directApiKey) return null;
  const directBaseUrl = (process.env["OPENAI_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const directModel = process.env["OPENAI_IMAGE_QA_MODEL"] ?? process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna";
  const label = opts.label ?? "vision QA";

  if (fetchImpl === (fetch as unknown as FetchLike)) {
    const capable = await ensureVisionCapability({
      baseUrl: directBaseUrl,
      apiKey: directApiKey,
      model: directModel,
      label: "direct-openai",
      timeoutMs: 15_000,
    });
    if (!capable) return null;
  }

  return requestVisionJson({
    baseUrl: directBaseUrl,
    apiKey: directApiKey,
    model: directModel,
    content,
    maxCompletionTokens,
    timeoutMs: opts.timeoutMs,
    label: `${label} (direct)`,
  }, fetchImpl);
}

async function askVision(
  image: { bytes: Uint8Array; media_type: string },
  instruction: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown> | null> {
  return askVisionMany([image], instruction, fetchImpl, 220);
}

export async function checkGeneratedImageMatchesNarration(
  image: { bytes: Uint8Array; media_type: string },
  narration: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SemanticQaResult | null> {
  const line = narration.trim().slice(0, 400);
  if (!line) return null;
  const parsed = await askVision(
    image,
    `This illustration plays under this spoken narration: "${line}"\n\nDecide ONLY whether it actively contradicts or materially misrepresents the line (wrong event, wrong causal direction, figurative phrase rendered as a false literal event). Do NOT flag an image merely for being atmospheric, partial, stylised, loose, abstract, or oblique b-roll. If you are unsure, answer false. Respond ONLY JSON: {\"contradicts_narration\":true|false,\"reason\":\"one short sentence\"}`,
    fetchImpl,
  );
  if (!parsed || typeof parsed["contradicts_narration"] !== "boolean") return null;
  return {
    contradictsNarration: parsed["contradicts_narration"],
    reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "",
  };
}

/** Rank 2-4 already-clean candidates for a hero shot. */
export async function rankHeroImageCandidates(
  images: Array<{ bytes: Uint8Array; media_type: string }>,
  context: { prompt: string; narration: string; heroRole: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<HeroRankResult | null> {
  if (images.length < 2) return images.length === 1 ? { bestIndex: 0, reason: "only candidate" } : null;
  const parsed = await askVisionMany(
    images,
    `You are selecting the strongest frame for a HERO beat in a YouTube illustrated story. Images are attached in candidate order 0..${images.length - 1}.\nHero role: ${context.heroRole}\nIntended shot: ${context.prompt.slice(0, 360)}\nNarration: ${context.narration.slice(0, 400)}\n\nChoose the single candidate that is most immediately legible, emotionally readable, compositionally strong at thumbnail-like glance, relevant to the intended shot, and least affected by obvious AI artefacts. For hook role, prioritize instant tension/question. Do not reward extra text or decorative complexity. Respond ONLY JSON: {\"best_index\":0,\"reason\":\"one short sentence\"}`,
    fetchImpl,
    260,
  );
  const idx = parsed?.["best_index"];
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= images.length) return null;
  return { bestIndex: idx, reason: typeof parsed?.["reason"] === "string" ? parsed["reason"] : "" };
}

const SCORE_KEYS = [
  "opening_visual_strength",
  "scene_relevance",
  "subject_legibility",
  "emotional_readability",
  "shot_variety",
  "visual_redundancy",
  "continuity",
  "style_consistency",
  "ai_artifacts",
  "payoff_visual_strength",
] as const;

type ScoreKey = typeof SCORE_KEYS[number];

function emptyScores(value = 1): VisualSequenceReviewResult["scores"] {
  return {
    opening_visual_strength: value,
    scene_relevance: value,
    subject_legibility: value,
    emotional_readability: value,
    shot_variety: value,
    visual_redundancy: value,
    continuity: value,
    style_consistency: value,
    ai_artifacts: value,
    payoff_visual_strength: value,
  };
}

/**
 * One compact episode-level visual review layer, implemented as overlapping
 * windows so long episodes do not send dozens of full images in one request.
 * Local windows catch repeated adjacent compositions and continuity/style
 * drift; including the first and final shot in every later window preserves
 * hook/payoff/identity context. Scores are combined pessimistically (minimum)
 * and flagged shot ids are unioned for targeted regeneration.
 */
export async function reviewIllustratedSequence(
  entries: VisualSequenceEntry[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<VisualSequenceReviewResult | null> {
  if (entries.length < 2) return null;

  const WINDOW = 6;
  const STRIDE = 5;
  const chunks: VisualSequenceEntry[][] = [];
  for (let start = 0; start < entries.length; start += STRIDE) {
    const slice = entries.slice(start, start + WINDOW);
    if (slice.length === 0) break;
    const withAnchors = [...slice];
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    if (!withAnchors.some((e) => e.shot_id === first.shot_id)) withAnchors.unshift(first);
    if (!withAnchors.some((e) => e.shot_id === last.shot_id)) withAnchors.push(last);
    chunks.push(withAnchors);
    if (start + WINDOW >= entries.length) break;
  }

  let combined = emptyScores(1);
  const flagged = new Set<string>();
  const reasons: string[] = [];
  let completed = 0;

  for (const chunk of chunks) {
    const index = chunk.map((e, i) => `${i}: shot=${e.shot_id}; function=${e.shot_function}; hero=${e.hero}; prompt=${e.prompt.slice(0, 180)}; narration=${e.narration.slice(0, 180)}`).join("\n");
    const validIds = new Set(chunk.map((e) => e.shot_id));
    const parsed = await askVisionMany(
      chunk.map((e) => e.image),
      `Review this ORDERED window from one illustrated YouTube episode. Image order exactly matches this list:\n${index}\n\nScore 0..1: opening_visual_strength (first episode shot must be the strongest attention-grabber), scene_relevance, subject_legibility, emotional_readability, shot_variety, visual_redundancy (1 means little harmful repetition), continuity, style_consistency, ai_artifacts (1 means clean/no obvious artefacts), payoff_visual_strength (final episode shot should visibly resolve/land the story). Flag ONLY shot ids that should be regenerated before render because a concrete visual defect/repetition/irrelevance is materially hurting the episode. Do not flag merely because the art is stylised or calm. Respond ONLY JSON: {\"scores\":{\"opening_visual_strength\":0.0,\"scene_relevance\":0.0,\"subject_legibility\":0.0,\"emotional_readability\":0.0,\"shot_variety\":0.0,\"visual_redundancy\":0.0,\"continuity\":0.0,\"style_consistency\":0.0,\"ai_artifacts\":0.0,\"payoff_visual_strength\":0.0},\"flagged_shots\":[\"scene:shot\"],\"reason\":\"short concrete summary\"}`,
      fetchImpl,
      900,
      { timeoutMs: 45000, label: "episode-visual-review" },
    );
    if (!parsed || typeof parsed["scores"] !== "object" || parsed["scores"] === null) continue;
    completed++;
    const scoreObj = parsed["scores"] as Record<string, unknown>;
    for (const key of SCORE_KEYS) combined[key] = Math.min(combined[key], clampScore(scoreObj[key]));
    const ids = Array.isArray(parsed["flagged_shots"]) ? parsed["flagged_shots"] : [];
    for (const id of ids) if (typeof id === "string" && validIds.has(id)) flagged.add(id);
    if (typeof parsed["reason"] === "string" && parsed["reason"].trim()) reasons.push(parsed["reason"].trim());
  }

  if (completed === 0) return null;
  return {
    scores: combined,
    flagged_shots: [...flagged],
    reason: reasons.slice(0, 4).join(" | ").slice(0, 1200),
    reviewed_shots: entries.length,
  };
}
