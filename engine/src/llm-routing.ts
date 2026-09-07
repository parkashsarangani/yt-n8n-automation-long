/**
 * Shared LLM routing controls.
 *
 * The Shorts and Long projects run on the same host. Shorts owns the pinned
 * FreeLLMAPI container and persistent encrypted provider state; Long joins that
 * Docker network and uses the same FreeLLMAPI instance without declaring a
 * second container/volume. Long still owns its application-level fail-open to
 * direct OpenAI so a Shorts deployment/network incident cannot make reasoning
 * unavailable when the paid fallback is configured.
 *
 * RFC 0010 intentionally does NOT use FreeLLMAPI's automatic text model
 * selection. Production reasoning is pinned to a Google Gemini model so an
 * `auto` route can never silently lower output quality. Visual QA is a separate
 * direct-OpenAI path and therefore does not belong in this router.
 */

export type LlmRouterMode = "freellmapi" | "direct";

export interface LlmRoutingConfig {
  mode: LlmRouterMode;
  failOpenToDirect: boolean;
  baseUrl: string;
  apiKey: string | undefined;
  textModel: string;
  timeoutMs: number;
}

export const DEFAULT_FREELLMAPI_BASE_URL = "http://freellmapi:3001/v1";
export const DEFAULT_FREELLMAPI_TEXT_MODEL = "gemini-3.5-flash";
export const DEFAULT_LLM_ROUTER_TIMEOUT_MS = 120_000;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  return normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no";
}

function timeout(value: string | undefined): number {
  const parsed = Number(clean(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_ROUTER_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(parsed));
}

export function assertPinnedGoogleTextModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) throw new Error("FREELLMAPI_TEXT_MODEL must be a concrete Google Gemini model");
  if (/^auto(?::|$)/i.test(normalized)) {
    throw new Error(
      "FREELLMAPI_TEXT_MODEL may not use auto routing; pin a Google Gemini model such as gemini-3.5-flash",
    );
  }
  if (!/gemini/i.test(normalized)) {
    throw new Error(
      `FREELLMAPI_TEXT_MODEL must be a Google Gemini model; received '${normalized}'`,
    );
  }
  return normalized;
}

/**
 * Match the Shorts router semantics for provider selection: every value except
 * the explicit word "direct" means FreeLLMAPI-first. Model selection itself is
 * intentionally NOT automatic: FreeLLM text must be pinned to Gemini.
 */
export function llmRoutingConfig(env: NodeJS.ProcessEnv = process.env): LlmRoutingConfig {
  const rawMode = clean(env["LLM_ROUTER_MODE"])?.toLowerCase();
  const mode: LlmRouterMode = rawMode === "direct" ? "direct" : "freellmapi";
  const configuredTextModel = clean(env["FREELLMAPI_TEXT_MODEL"]) ?? DEFAULT_FREELLMAPI_TEXT_MODEL;
  const textModel = mode === "freellmapi"
    ? assertPinnedGoogleTextModel(configuredTextModel)
    : configuredTextModel;

  return {
    mode,
    failOpenToDirect: bool(env["LLM_ROUTER_FAIL_OPEN_TO_DIRECT"], true),
    baseUrl: (clean(env["FREELLMAPI_BASE_URL"]) ?? DEFAULT_FREELLMAPI_BASE_URL).replace(/\/$/, ""),
    apiKey: clean(env["FREELLMAPI_API_KEY"]),
    textModel,
    timeoutMs: timeout(env["LLM_ROUTER_TIMEOUT_MS"]),
  };
}

export function isFreeFirst(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmRoutingConfig(env).mode === "freellmapi";
}
