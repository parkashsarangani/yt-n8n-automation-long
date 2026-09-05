import { llmRoutingConfig } from "./llm-routing.ts";
import type { QaImage, VisualBeatFetch } from "./visual-beat-qa.ts";
import type { VisualBeat } from "./visual-routing.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 45_000;

export interface BlindComparisonResult {
  winner: "A" | "B" | "tie";
  a_semantic: number;
  a_interest: number;
  b_semantic: number;
  b_interest: number;
  reason: string;
}

function uri(image: QaImage): string {
  return `data:${image.media_type};base64,${Buffer.from(image.bytes).toString("base64")}`;
}
function score(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

async function request(
  endpoint: { baseUrl: string; apiKey: string; model: string; label: string },
  optionA: QaImage[],
  optionB: QaImage[],
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch,
): Promise<BlindComparisonResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: [
      "Blindly compare two candidate visuals for the SAME narrated YouTube beat. You are not told which system made either option.",
      `NARRATION: ${beat.narration}`,
      `VIEWER TAKEAWAY: ${beat.visual_contract.viewer_takeaway}`,
      `MUST SHOW: ${beat.visual_contract.required.join("; ")}`,
      `ACTION/STATE: ${beat.visual_contract.required_action || "none"}`,
      `FORBIDDEN/MISLEADING: ${beat.visual_contract.forbidden.join("; ") || "none"}`,
      "Judge semantic specificity first, then visual interest. Generic topical B-roll must lose to a specific explanatory visual. Do not reward polish when it is semantically wrong.",
      "Return JSON only: {\"winner\":\"A|B|tie\",\"a_semantic\":0.0,\"a_interest\":0.0,\"b_semantic\":0.0,\"b_interest\":0.0,\"reason\":\"one sentence\"}",
    ].join("\n") },
    { type: "text", text: "OPTION A — chronological rendered frame samples:" },
    ...optionA.slice(0, 3).map((image) => ({ type: "image_url", image_url: { url: uri(image), detail: "low" } })),
    { type: "text", text: "OPTION B — chronological rendered frame samples:" },
    ...optionB.slice(0, 3).map((image) => ({ type: "image_url", image_url: { url: uri(image), detail: "low" } })),
  ];
  try {
    const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: "user", content }],
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = payload.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const winner = parsed["winner"] === "A" || parsed["winner"] === "B" ? parsed["winner"] : "tie";
    return {
      winner,
      a_semantic: score(parsed["a_semantic"]),
      a_interest: score(parsed["a_interest"]),
      b_semantic: score(parsed["b_semantic"]),
      b_interest: score(parsed["b_interest"]),
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 500) : "",
    };
  } catch (error) {
    console.warn(`[visual-benchmark-judge] ${endpoint.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function compareRenderedVisualsBlind(
  optionA: QaImage[],
  optionB: QaImage[],
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch = fetch as unknown as VisualBeatFetch,
): Promise<BlindComparisonResult | null> {
  const routing = llmRoutingConfig();
  if (routing.mode === "freellmapi" && routing.apiKey) {
    const result = await request({ baseUrl: routing.baseUrl, apiKey: routing.apiKey, model: routing.visionModel, label: "freellmapi" }, optionA, optionB, beat, fetchImpl);
    if (result) return result;
    if (!routing.failOpenToDirect) return null;
  }
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) return null;
  return request({
    baseUrl: (process.env["OPENAI_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey,
    model: process.env["OPENAI_IMAGE_QA_MODEL"] ?? process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna",
    label: "direct-openai",
  }, optionA, optionB, beat, fetchImpl);
}
