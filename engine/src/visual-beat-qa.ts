import { llmRoutingConfig } from "./llm-routing.ts";
import type { CandidateScores, VisualBeat } from "./visual-routing.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 45_000;

export interface QaImage {
  bytes: Uint8Array;
  media_type: string;
}

export interface VisualBeatQaResult {
  scores: CandidateScores;
  reason: string;
  generic_filler: boolean;
  why_failure: boolean;
}

export type VisualBeatFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function dataUri(image: QaImage): string {
  return `data:${image.media_type};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

function score(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

interface RequestFrames {
  candidate: QaImage[];
  previous?: QaImage;
  next?: QaImage;
}

function imageParts(frames: RequestFrames): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (frames.previous) {
    parts.push({ type: "text", text: "PREVIOUS SELECTED VISUAL:" });
    parts.push({ type: "image_url", image_url: { url: dataUri(frames.previous), detail: "low" } });
  }
  parts.push({ type: "text", text: `CURRENT CANDIDATE — ${frames.candidate.length} sampled frame(s) in chronological order:` });
  for (const image of frames.candidate) {
    parts.push({ type: "image_url", image_url: { url: dataUri(image), detail: "low" } });
  }
  if (frames.next) {
    parts.push({ type: "text", text: "FOLLOWING SELECTED/PLANNED VISUAL:" });
    parts.push({ type: "image_url", image_url: { url: dataUri(frames.next), detail: "low" } });
  }
  return parts;
}

async function request(
  endpoint: { baseUrl: string; apiKey: string; model: string; label: string },
  frames: RequestFrames,
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch,
): Promise<VisualBeatQaResult | null> {
  if (frames.candidate.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const required = beat.visual_contract.required.join("; ");
  const forbidden = beat.visual_contract.forbidden.join("; ") || "none";
  const instruction = [
    "Judge the CURRENT CANDIDATE as the exact visual shown under one narration beat in a YouTube explainer/story.",
    "When several CURRENT frames are supplied they are chronological samples from one video segment: judge the segment as a whole, including whether the required action becomes visible during it.",
    "PREVIOUS/FOLLOWING images, when supplied, are context only. Use them to judge identity/location continuity and visual repetition; do not score their semantics against the current narration.",
    `NARRATION: ${beat.narration.slice(0, 500)}`,
    `PREVIOUS NARRATIVE CONTEXT: ${beat.context.previous.slice(0, 350) || "none"}`,
    `NEXT NARRATIVE CONTEXT: ${beat.context.next.slice(0, 350) || "none"}`,
    `VIEWER MUST TAKE AWAY: ${beat.visual_contract.viewer_takeaway.slice(0, 300)}`,
    `MUST VISIBLY INCLUDE: ${required.slice(0, 700)}`,
    `REQUIRED ACTION/STATE: ${beat.visual_contract.required_action.slice(0, 300) || "none"}`,
    `FORBIDDEN/MISLEADING: ${forbidden.slice(0, 550)}`,
    `EMOTIONAL INTENT: ${beat.intent.emotion}`,
    `COMPOSITION INTENT: ${beat.retention.composition}`,
    `CONTINUITY GROUP: ${beat.continuity.group || "none"}; recurring entities: ${beat.continuity.entities.join(", ") || "none"}`,
    "semantic_match=whether the current candidate immediately communicates the required concepts, not merely a related topic. action_match=whether the required physical action/state is actually visible; use 1.0 if none required. visual_interest=specificity, composition, legibility, useful motion/visual information and attention value rather than generic filler. continuity=preservation of recurring identity/location/object cues against adjacent visuals when supplied; use 1.0 if no continuity is required. Any forbidden element/material contradiction sharply lowers semantic_match.",
    "generic_filler=true when this visual could plausibly accompany many unrelated sentences (generic clock, generic office worker, generic landscape, generic scientist, etc.) rather than this beat specifically. why_failure=true when a normal viewer would reasonably ask 'why am I seeing this?' while hearing the narration.",
    "Respond ONLY JSON: {\"semantic_match\":0.0,\"action_match\":0.0,\"visual_interest\":0.0,\"continuity\":0.0,\"generic_filler\":false,\"why_failure\":false,\"reason\":\"one concrete sentence\"}",
  ].join("\n");

  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: "user", content: [{ type: "text", text: instruction }, ...imageParts(frames)] }],
        max_completion_tokens: 600,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[visual-beat-qa] ${endpoint.label} failed: HTTP ${res.status}`);
      return null;
    }
    const payload = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = payload.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      scores: {
        semantic_match: score(parsed["semantic_match"]),
        action_match: score(parsed["action_match"]),
        visual_interest: score(parsed["visual_interest"]),
        continuity: score(parsed["continuity"]),
      },
      generic_filler: bool(parsed["generic_filler"]),
      why_failure: bool(parsed["why_failure"]),
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 500) : "",
    };
  } catch (err) {
    console.warn(`[visual-beat-qa] ${endpoint.label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function routedRequest(
  frames: RequestFrames,
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch,
): Promise<VisualBeatQaResult | null> {
  const routing = llmRoutingConfig();
  if (routing.mode === "freellmapi" && routing.apiKey) {
    const free = await request({
      baseUrl: routing.baseUrl,
      apiKey: routing.apiKey,
      model: routing.visionModel,
      label: "freellmapi",
    }, frames, beat, fetchImpl);
    if (free) return free;
    if (!routing.failOpenToDirect) return null;
  }

  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) return null;
  return request({
    baseUrl: (process.env["OPENAI_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey,
    model: process.env["OPENAI_IMAGE_QA_MODEL"] ?? process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna",
    label: "direct-openai",
  }, frames, beat, fetchImpl);
}

export async function scoreVisualBeatImage(
  image: QaImage,
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch = fetch as unknown as VisualBeatFetch,
  adjacent: { previous?: QaImage; next?: QaImage } = {},
): Promise<VisualBeatQaResult | null> {
  return routedRequest({ candidate: [image], ...adjacent }, beat, fetchImpl);
}

export async function scoreVisualBeatFrames(
  frames: QaImage[],
  beat: VisualBeat,
  adjacent: { previous?: QaImage; next?: QaImage } = {},
  fetchImpl: VisualBeatFetch = fetch as unknown as VisualBeatFetch,
): Promise<VisualBeatQaResult | null> {
  return routedRequest({ candidate: frames.slice(0, 6), ...adjacent }, beat, fetchImpl);
}
