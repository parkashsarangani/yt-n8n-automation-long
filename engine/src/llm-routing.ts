/**
 * Shared LLM routing controls.
 *
 * The Shorts and Long projects run on the same host. Shorts owns the pinned
 * FreeLLMAPI container and persistent encrypted provider state; Long joins that
 * Docker network and uses the same FreeLLMAPI instance without declaring a
 * second container/volume. Long still owns its application-level fail-open to
 * direct OpenAI so a Shorts deployment/network incident cannot make reasoning
 * unavailable when the paid fallback is configured.
 */

export type LlmRouterMode = "freellmapi" | "direct";

export interface LlmRoutingConfig {
  mode: LlmRouterMode;
  failOpenToDirect: boolean;
  baseUrl: string;
  apiKey: string | undefined;
  textModel: string;
  visionModel: string;
  timeoutMs: number;
}

export const DEFAULT_FREELLMAPI_BASE_URL = "http://freellmapi:3001/v1";
export const DEFAULT_FREELLMAPI_TEXT_MODEL = "auto:smart";
export const DEFAULT_FREELLMAPI_VISION_MODEL = "auto:smart";
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

/**
 * Match the Shorts router semantics: every value except the explicit word
 * "direct" means free-first. That makes rollback a one-value switch while an
 * accidental typo cannot silently opt the deployment into paid-primary mode.
 */
export function llmRoutingConfig(env: NodeJS.ProcessEnv = process.env): LlmRoutingConfig {
  const rawMode = clean(env["LLM_ROUTER_MODE"])?.toLowerCase();
  return {
    mode: rawMode === "direct" ? "direct" : "freellmapi",
    failOpenToDirect: bool(env["LLM_ROUTER_FAIL_OPEN_TO_DIRECT"], true),
    baseUrl: (clean(env["FREELLMAPI_BASE_URL"]) ?? DEFAULT_FREELLMAPI_BASE_URL).replace(/\/$/, ""),
    apiKey: clean(env["FREELLMAPI_API_KEY"]),
    textModel: clean(env["FREELLMAPI_TEXT_MODEL"]) ?? DEFAULT_FREELLMAPI_TEXT_MODEL,
    visionModel: clean(env["FREELLMAPI_VISION_MODEL"]) ?? DEFAULT_FREELLMAPI_VISION_MODEL,
    timeoutMs: timeout(env["LLM_ROUTER_TIMEOUT_MS"]),
  };
}

export function isFreeFirst(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmRoutingConfig(env).mode === "freellmapi";
}
