import { llmRoutingConfig } from "./llm-routing.ts";
import type { CandidateScores, VisualBeat } from "./visual-routing.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 30_000;

export interface VisualBeatQaResult {
  scores: CandidateScores;
  reason: string;
}

export type VisualBeatFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function dataUri(image: { bytes: Uint8Array; media_type: string }): string {
  return `data:${image.media_type};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

function score(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

async function request(
  endpoint: { baseUrl: string; apiKey: string; model: string; label: string },
  image: { bytes: Uint8Array; media_type: string },
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch,
): Promise<VisualBeatQaResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const required = beat.visual_contract.required.join("; ");
  const forbidden = beat.visual_contract.forbidden.join("; ") || "none";
  const instruction = [
    "Judge this image as the exact visual shown under one narration beat in a YouTube explainer/story.",
    `NARRATION: ${beat.narration.slice(0, 500)}`,
    `VIEWER MUST TAKE AWAY: ${beat.visual_contract.viewer_takeaway.slice(0, 300)}`,
    `MUST VISIBLY INCLUDE: ${required.slice(0, 600)}`,
    `REQUIRED ACTION/STATE: ${beat.visual_contract.required_action.slice(0, 300) || "none"}`,
    `FORBIDDEN/MISLEADING: ${forbidden.slice(0, 500)}`,
    `EMOTIONAL INTENT: ${beat.intent.emotion}`,
    `COMPOSITION INTENT: ${beat.retention.composition}`,
    `CONTINUITY GROUP: ${beat.continuity.group || "none"}; recurring entities: ${beat.continuity.entities.join(", ") || "none"}`,
    "Score each dimension independently from 0.0 to 1.0. semantic_match asks whether the required concepts are immediately visible, not merely topically associated. action_match asks whether the required physical action/state is actually visible; use 1.0 when no action is required. visual_interest asks whether the frame is legible, specific, compositionally strong and attention-worthy rather than generic filler. continuity asks whether the requested recurring identity/location/object cues are preserved; use 1.0 when no continuity is required. Any forbidden element or material contradiction must sharply reduce semantic_match.",
    "Respond ONLY JSON: {\"semantic_match\":0.0,\"action_match\":0.0,\"visual_interest\":0.0,\"continuity\":0.0,\"reason\":\"one concrete sentence\"}",
  ].join("\n");

  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: dataUri(image), detail: "low" } },
          ],
        }],
        max_completion_tokens: 500,
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
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 500) : "",
    };
  } catch (err) {
    console.warn(`[visual-beat-qa] ${endpoint.label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function scoreVisualBeatImage(
  image: { bytes: Uint8Array; media_type: string },
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch = fetch as unknown as VisualBeatFetch,
): Promise<VisualBeatQaResult | null> {
  const routing = llmRoutingConfig();
  if (routing.mode === "freellmapi" && routing.apiKey) {
    const free = await request({
      baseUrl: routing.baseUrl,
      apiKey: routing.apiKey,
      model: routing.visionModel,
      label: "freellmapi",
    }, image, beat, fetchImpl);
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
  }, image, beat, fetchImpl);
}
