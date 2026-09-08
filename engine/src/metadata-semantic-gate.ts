/**
 * Text-only visual semantic proxy — `metadataSemanticGate`.
 *
 * This is NOT vision. Free image-capable models are unavailable and paid vision
 * is off for normal runs, so instead of pretending to inspect pixels we screen
 * the SOURCING INTENT from metadata we already have: the narration, the beat's
 * required / forbidden content, and the exact prompt / query / asset metadata
 * used to source the visual.
 *
 * One free-text-model call answers: "given these requirements and the exact
 * prompt/query/metadata, is this asset semantically LIKELY to match the beat?"
 *
 * It is legitimate for:
 *   - rejecting obviously off-topic sourcing intents
 *   - prompt / narration consistency
 *   - search-query quality
 *   - catching generic-filler intent
 *   - catching a forbidden concept named in the prompt/query
 *
 * It must NEVER be read as confirming: visible action, identity continuity,
 * garbled text, composition, object scale, or pixel-level presence of a
 * requirement. Those need real vision. Results are tagged `metadata_proxy`.
 */

import { OpenAIProvider } from "./providers/openai.ts";
import type { ModelProvider } from "./provider.ts";

export interface SemanticGateInput {
  narration: string;
  viewer_takeaway?: string;
  required: string[];
  forbidden: string[];
  required_action?: string;
  /** "generated_image" | "stock_video" | "generated_video" | "semantic_graphic" | ... */
  visual_mode: string;
  /** The exact prompt handed to the image/video model, when applicable. */
  generation_prompt?: string;
  /** The exact stock search query used, when applicable. */
  stock_query?: string;
  /** Stock title/description/tags, generation concept, provenance, mode notes. */
  asset_metadata?: string;
}

export type SemanticGateConcern =
  | "none"
  | "off_topic"
  | "generic_filler"
  | "weak_query"
  | "prompt_narration_mismatch"
  | "forbidden_present"
  | "missing_required_intent";

/**
 * Explicit, source-aware outcome of the metadata screen.
 *
 *   PASS   — the sourcing intent is semantically likely to fit the beat.
 *   REJECT — the prompt/query is off-topic, forbidden, filler, or omits the subject.
 *   UNAVAILABLE — the screen could not run (free text chain outage); represented
 *                 by a `null` return from `metadataSemanticGate`, never a score.
 *
 * `confidence` is the model's confidence in THIS METADATA DECISION. It is never
 * a pixel-quality score and must not be laundered into semantic_match /
 * visual_interest / action / continuity as if an image had been inspected.
 */
export type SemanticGateDecision = "pass" | "reject";

export interface SemanticGateResult {
  decision: SemanticGateDecision;
  /** Back-compat convenience: `decision === "pass"`. */
  accept: boolean;
  reason: string;
  concern: SemanticGateConcern;
  /** The model's own 0..1 confidence in this metadata judgement. Not a pixel score. */
  confidence: number;
  /** Always "metadata_proxy" — this result did not inspect an image. */
  source: "metadata_proxy";
}

const GATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["accept", "reason", "concern", "confidence"],
  properties: {
    accept: { type: "boolean" },
    reason: { type: "string", minLength: 1, maxLength: 400 },
    concern: {
      type: "string",
      enum: [
        "none",
        "off_topic",
        "generic_filler",
        "weak_query",
        "prompt_narration_mismatch",
        "forbidden_present",
        "missing_required_intent",
      ],
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["overall"],
      properties: { overall: { type: "number", minimum: 0, maximum: 1 } },
    },
  },
} as const;

function clip(value: string | undefined, max: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPrompt(input: SemanticGateInput): string {
  return [
    "You are screening the SOURCING INTENT of a visual for one narration beat in a YouTube explainer/story.",
    "You are working from METADATA ONLY. You cannot and must not claim to see the image or video.",
    "",
    `NARRATION: ${clip(input.narration, 600)}`,
    input.viewer_takeaway ? `VIEWER SHOULD TAKE AWAY: ${clip(input.viewer_takeaway, 300)}` : "",
    `MUST BE ABOUT: ${clip(input.required.join("; "), 700) || "(unspecified)"}`,
    input.required_action ? `INTENDED ACTION/STATE: ${clip(input.required_action, 300)}` : "",
    `MUST NOT BE: ${clip(input.forbidden.join("; "), 500) || "(none)"}`,
    `VISUAL MODE: ${input.visual_mode}`,
    input.generation_prompt ? `EXACT GENERATION PROMPT: ${clip(input.generation_prompt, 1200)}` : "",
    input.stock_query ? `EXACT STOCK SEARCH QUERY: ${clip(input.stock_query, 300)}` : "",
    input.asset_metadata ? `ASSET METADATA: ${clip(input.asset_metadata, 700)}` : "",
    "",
    "Decide whether this sourcing intent is semantically LIKELY to produce a visual that fits the beat:",
    "- accept=false if the prompt/query is off-topic, describes something the beat forbids, is so generic it would fit many unrelated sentences, or plainly omits what the narration is about.",
    "- accept=true if the prompt/query specifically targets the beat's subject (and its intended action, when stated).",
    "- Do NOT reject merely because you cannot verify the pixels — that is expected. Judge the INTENT.",
    "- weak_query: a stock query too vague/broad to reliably return the needed shot. generic_filler: intent that fits many unrelated beats. prompt_narration_mismatch: the prompt describes a different subject/event than the narration. forbidden_present: the prompt/query names a forbidden concept. missing_required_intent: the prompt/query never mentions the beat's core subject.",
    "",
    'Respond ONLY JSON: {"accept":true,"reason":"one concrete sentence","concern":"none","confidence":{"overall":0.0}}',
  ].filter(Boolean).join("\n");
}

/**
 * Run the proxy. Returns `null` when the free text chain is entirely
 * unavailable (an infrastructure outage, not a quality signal) — callers treat
 * that the same as any other QA-unavailable result.
 */
export async function metadataSemanticGate(
  input: SemanticGateInput,
  opts: { provider?: ModelProvider } = {},
): Promise<SemanticGateResult | null> {
  const provider = opts.provider ?? new OpenAIProvider();
  try {
    const { value } = await provider.complete({
      prompt: buildPrompt(input),
      outputSchema: GATE_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 400,
      thinking: false,
      // This gate authorizes rendering an asset (and, with the hardened
      // release, whether the run ships at all). run_112aa43f showed the free
      // chain landing on a 20B model that returned HTTP 400 for this
      // structured request, dropping every generated image. Grade it on the
      // paid model when one is available; degrade to the free chain otherwise.
      preferPaidReasoning: true,
    });
    const parsed = value as Record<string, unknown>;
    const rawConcern = typeof parsed["concern"] === "string" ? parsed["concern"] : "none";
    const concern = (GATE_SCHEMA.properties.concern.enum as readonly string[]).includes(rawConcern)
      ? rawConcern as SemanticGateConcern
      : "none";
    const confObj = parsed["confidence"];
    const overall = confObj && typeof confObj === "object" && typeof (confObj as Record<string, unknown>)["overall"] === "number"
      ? Math.max(0, Math.min(1, (confObj as Record<string, number>)["overall"]!))
      : 0.5;
    const decision: SemanticGateDecision = parsed["accept"] === true ? "pass" : "reject";
    return {
      decision,
      accept: decision === "pass",
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 400) : "",
      concern,
      confidence: overall,
      source: "metadata_proxy",
    };
  } catch (err) {
    console.warn(`[metadata-semantic-gate] proxy unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
