export type TtsModerationDecision = "allow" | "review" | "block";

export interface ModerationCategoryResult {
  name: string;
  flagged: boolean;
  score: number;
}

export interface OpenAiModerationResult {
  request_id: string;
  model: string;
  flagged: boolean;
  categories: ModerationCategoryResult[];
}

export interface ElevenLabsRiskSignal {
  id: string;
  severity: "review" | "block";
  educational_context: boolean;
}

export interface TtsSceneDecision {
  decision: TtsModerationDecision;
  reasons: string[];
  signals: ElevenLabsRiskSignal[];
}

export interface OpenAiModerationOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RawModerationResult {
  flagged?: boolean;
  categories?: Record<string, boolean>;
  category_scores?: Record<string, number>;
}

interface RawModerationResponse {
  id?: string;
  model?: string;
  results?: RawModerationResult[];
}

const POLICY_VERSION = "elevenlabs-pup-2026-08-17+openai-omni-v1";
export const TTS_POLICY_VERSION = POLICY_VERSION;
export const DEFAULT_MODERATION_MODEL = "omni-moderation-latest";

const BLOCK_OPENAI_CATEGORIES = new Set([
  "sexual/minors",
  "illicit",
  "illicit/violent",
  "self-harm/instructions",
]);

const EDUCATIONAL_CONTEXT = /\b(?:educational|explainer|documentary|news report|reporting on|history of|historical|warning signs?|fraud prevention|scam awareness|how scams? work|avoid(?:ing)? scams?|protect yourself|do not|don't|never share|never send|fictional|in a movie|in a book)\b/i;

const ELEVENLABS_RULES: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "sensitive-data-solicitation",
    pattern: /\b(?:send|share|provide|give|tell|enter|read out)\b.{0,55}\b(?:password|passcode|one[- ]time (?:code|password)|otp|pin|cvv|card number|bank (?:login|details|account)|social security number|seed phrase|private key|health data)\b/i,
  },
  {
    id: "financial-scam-solicitation",
    pattern: /\b(?:send|wire|transfer|deposit|pay|purchase)\b.{0,70}\b(?:money|funds|crypto|bitcoin|gift cards?|fee)\b.{0,80}\b(?:urgent|immediately|unlock|claim|prize|refund|guaranteed|double|triple|verify|secret)\b|\b(?:guaranteed|risk[- ]free)\b.{0,45}\b(?:return|profit|income|investment)\b|\b(?:double|triple)\b.{0,30}\b(?:your )?(?:money|investment)\b/i,
  },
  {
    id: "credential-phishing",
    pattern: /\b(?:phish(?:ing)?|fake login|spoof(?:ed|ing)? (?:login|bank|support)|steal (?:credentials|passwords?|account access))\b/i,
  },
  {
    id: "guardrail-evasion",
    pattern: /\b(?:bypass|evade|circumvent|defeat|avoid)\b.{0,55}\b(?:moderation|safety (?:check|filter|system)|guardrail|voice captcha|voice verification|detection filter)\b/i,
  },
  {
    id: "unauthorized-robocalling-spam",
    pattern: /\b(?:robocall|call bombing|mass[- ]?call|bulk[- ]?call|spam campaign|harvest (?:emails?|phone numbers?|contacts?))\b/i,
  },
  {
    id: "deceptive-impersonation",
    pattern: /\b(?:impersonate|pretend to be|pose as|fake being)\b.{0,70}\b(?:bank|police|government|tax office|support agent|customer support|doctor|lawyer|relative|employee|executive|ceo|celebrity|public official)\b/i,
  },
  {
    id: "extortion-or-coercion",
    pattern: /\b(?:blackmail|extort|coerce|threaten)\b.{0,80}\b(?:pay|money|send|transfer|comply|information|photos?|account)\b/i,
  },
];

function clampScore(value: unknown): number {
  const score = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, score));
}

export function findElevenLabsRiskSignals(text: string): ElevenLabsRiskSignal[] {
  const educational = EDUCATIONAL_CONTEXT.test(text);
  const signals: ElevenLabsRiskSignal[] = [];
  for (const rule of ELEVENLABS_RULES) {
    if (!rule.pattern.test(text)) continue;
    signals.push({
      id: rule.id,
      severity: educational ? "review" : "block",
      educational_context: educational,
    });
  }
  return signals;
}

export function decideTtsScene(
  moderation: Pick<OpenAiModerationResult, "flagged" | "categories">,
  text: string,
): TtsSceneDecision {
  const reasons: string[] = [];
  let decision: TtsModerationDecision = "allow";
  let sawFlaggedCategory = false;

  for (const category of moderation.categories) {
    if (!category.flagged) continue;
    sawFlaggedCategory = true;
    if (BLOCK_OPENAI_CATEGORIES.has(category.name)) {
      decision = "block";
      reasons.push(`OpenAI moderation flagged blocking category ${category.name}`);
    } else if (decision !== "block") {
      decision = "review";
      reasons.push(`OpenAI moderation flagged review category ${category.name}`);
    }
  }

  // The provider-level flagged bit is the authoritative summary. Do not let a
  // newly introduced or unexpectedly shaped category bypass the TTS boundary.
  if (moderation.flagged && !sawFlaggedCategory && decision === "allow") {
    decision = "review";
    reasons.push("OpenAI moderation flagged the narration without a recognized category flag");
  }

  const signals = findElevenLabsRiskSignals(text);
  for (const signal of signals) {
    if (signal.severity === "block") {
      decision = "block";
    } else if (decision === "allow") {
      decision = "review";
    }
    reasons.push(
      `ElevenLabs-specific ${signal.id} signal${signal.educational_context ? " in educational/reporting context" : ""}`,
    );
  }

  return { decision, reasons, signals };
}

export async function moderateTextWithOpenAI(
  text: string,
  opts: OpenAiModerationOptions,
): Promise<OpenAiModerationResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model?.trim() || DEFAULT_MODERATION_MODEL;
  const baseUrl = (opts.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 30_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/moderations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`OpenAI moderation request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const requestHeader = response.headers.get("x-request-id")?.trim();
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI moderation HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  let body: RawModerationResponse;
  try {
    body = JSON.parse(bodyText) as RawModerationResponse;
  } catch {
    throw new Error("OpenAI moderation returned invalid JSON");
  }
  const raw = body.results?.[0];
  if (!raw || typeof raw.flagged !== "boolean") {
    throw new Error("OpenAI moderation response is missing results[0].flagged");
  }

  const names = new Set<string>([
    ...Object.keys(raw.categories ?? {}),
    ...Object.keys(raw.category_scores ?? {}),
  ]);
  const categories = [...names]
    .sort()
    .map((name) => ({
      name,
      flagged: Boolean(raw.categories?.[name]),
      score: clampScore(raw.category_scores?.[name]),
    }));

  return {
    request_id: requestHeader || body.id || "openai-moderation-request",
    model: body.model?.trim() || model,
    flagged: raw.flagged,
    categories,
  };
}
