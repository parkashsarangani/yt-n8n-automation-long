/**
 * Shared LLM routing controls.
 *
 * The Shorts and Long projects run on the same host and share one FreeLLMAPI
 * instance. Long joins that Docker network and uses it for every text/reasoning
 * step.
 *
 * Two hard operating constraints:
 *
 *  1. NO PAID MODEL CALLS FOR TEXT. There is no automatic direct-OpenAI
 *     fallback. Text requests try an explicit, ordered list of strong FREE
 *     models and, if every one is unavailable, fail loudly. `LLM_ROUTER_MODE`
 *     still accepts the explicit word `direct` as a manual operator rollback,
 *     but nothing selects it automatically.
 *
 *  2. Every model id is concrete. `auto` / `auto:*` is rejected: it lets the
 *     upstream proxy silently swap in a weaker model, and a prior incident
 *     showed `auto:smart` returning HTTP 200 from a text-only model with image
 *     parts dropped. Pin the ids.
 *
 * Visual QA is a separate concern and does not belong in this router.
 */

export type LlmRouterMode = "freellmapi" | "direct";

export interface LlmRoutingConfig {
  mode: LlmRouterMode;
  baseUrl: string;
  apiKey: string | undefined;
  /** Ordered fallback chain of concrete free model ids. Never empty, never `auto`. */
  textModels: string[];
  timeoutMs: number;
}

export const DEFAULT_FREELLMAPI_BASE_URL = "http://freellmapi:3001/v1";
export const DEFAULT_LLM_ROUTER_TIMEOUT_MS = 120_000;

/**
 * Ordered default fallback chain.
 *
 * Chosen 2026-09-07 by probing the running shared FreeLLMAPI instance with a
 * structured-output script-planning task (see the completion report). Every id
 * here returned well-formed JSON with sound content on a live probe; the whole
 * Gemini family was rate-limited / removed-upstream at the time, so none is
 * pinned as primary. The list is the resilience — free providers flip between
 * available and 502 minute to minute, so no single id is trusted alone.
 *
 *  - gpt-oss-120b            120B open-weights MoE, ~1.5s, most consistently up
 *  - llama-3.3-70b-fp8-fast  70B, Cloudflare Workers AI, strong general model
 *  - nemotron-3-super-120b   120B (12B active), strong, slower (~7-10s)
 *  - gpt-oss-20b             20B open-weights, solid, distinct provider path
 *
 * Override with FREELLMAPI_TEXT_MODELS (comma list) when the mix changes, e.g.
 * to prepend a Gemini id once Google capacity returns.
 */
export const DEFAULT_FREE_TEXT_MODELS: readonly string[] = Object.freeze([
  "gpt-oss-120b",
  "llama-3.3-70b-fp8-fast",
  "nemotron-3-super-120b",
  "gpt-oss-20b",
]);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function timeout(value: string | undefined): number {
  const parsed = Number(clean(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_ROUTER_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(parsed));
}

/**
 * Normalize a `,`-separated model list to concrete ids.
 *
 * Rejects `auto` / `auto:*` anywhere in the list and an empty result. This is
 * the single guard that keeps automatic provider selection out of production
 * text; every caller resolves its list through here.
 */
export function assertConcreteTextModels(raw: string | string[]): string[] {
  const ids = (Array.isArray(raw) ? raw : raw.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("FREELLMAPI_TEXT_MODELS resolved to an empty list; pin at least one concrete model id");
  }
  for (const id of ids) {
    if (/^auto(?::|$)/i.test(id)) {
      throw new Error(
        `FREELLMAPI_TEXT_MODELS may not contain auto routing ('${id}'); pin concrete model ids such as ${DEFAULT_FREE_TEXT_MODELS[0]}`,
      );
    }
  }
  return ids;
}

/**
 * Resolve the ordered free text-model chain.
 *
 * Precedence: `FREELLMAPI_TEXT_MODELS` (comma list) → `FREELLMAPI_TEXT_MODEL`
 * (single id, temporary back-compat) → the built-in default chain.
 */
export function resolveTextModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = clean(env["FREELLMAPI_TEXT_MODELS"])
    ?? clean(env["FREELLMAPI_TEXT_MODEL"])
    ?? DEFAULT_FREE_TEXT_MODELS.join(",");
  return assertConcreteTextModels(raw);
}

export function llmRoutingConfig(env: NodeJS.ProcessEnv = process.env): LlmRoutingConfig {
  const mode: LlmRouterMode = clean(env["LLM_ROUTER_MODE"])?.toLowerCase() === "direct" ? "direct" : "freellmapi";
  return {
    mode,
    baseUrl: (clean(env["FREELLMAPI_BASE_URL"]) ?? DEFAULT_FREELLMAPI_BASE_URL).replace(/\/$/, ""),
    apiKey: clean(env["FREELLMAPI_API_KEY"]),
    textModels: resolveTextModels(env),
    timeoutMs: timeout(env["LLM_ROUTER_TIMEOUT_MS"]),
  };
}

export function isFreeFirst(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmRoutingConfig(env).mode === "freellmapi";
}
