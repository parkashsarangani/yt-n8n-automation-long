/**
 * Shared LLM routing controls.
 *
 * The Shorts and Long projects run on the same host and share one FreeLLMAPI
 * instance. Long joins that Docker network and uses it as the free-first text
 * route. Paid OpenAI is a last-resort text fallback only when the capability
 * policy explicitly allows it.
 *
 * Hard operating constraints:
 *
 *  1. Every free model id is concrete. `auto` / `auto:*` is rejected: it lets
 *     the upstream proxy silently swap in a weaker model.
 *  2. Known-retired pins are removed before a request is attempted. A stale
 *     repository/environment pin must not consume every production run.
 *  3. High-output structured requests only try free models explicitly admitted
 *     to that workload. Smaller models remain available to ordinary agents.
 *
 * Visual QA is a separate concern and does not belong in this router.
 */

export type LlmRouterMode = "freellmapi" | "direct";

export interface LlmRoutingConfig {
  mode: LlmRouterMode;
  baseUrl: string;
  apiKey: string | undefined;
  /** Ordered fallback chain of concrete, non-retired free model ids. */
  textModels: string[];
  timeoutMs: number;
}

export const DEFAULT_FREELLMAPI_BASE_URL = "http://freellmapi:3001/v1";
export const DEFAULT_LLM_ROUTER_TIMEOUT_MS = 120_000;

/**
 * Models that are known not to be serviceable and must never be attempted even
 * if an old repository variable still contains them. Keep this list small and
 * evidence-based; it is a circuit breaker for stale pins, not a model catalog.
 */
export const RETIRED_FREE_TEXT_MODELS: ReadonlySet<string> = new Set([
  "gpt-oss-120b",
]);

/**
 * Requests above the ordinary 8k structured-output budget are deliberately
 * conservative. These are the only currently configured free candidates worth
 * probing for a large structured artifact such as visual_beat_plan. A 413 or
 * other incompatibility still disqualifies the candidate dynamically and the
 * chain advances; inclusion here is permission to try, not a promise that the
 * upstream provider can serve every payload.
 */
export const LARGE_STRUCTURED_FREE_TEXT_MODELS: ReadonlySet<string> = new Set([
  "llama-3.3-70b-fp8-fast",
  "nemotron-3-super-120b",
]);

export const ORDINARY_STRUCTURED_OUTPUT_TOKENS = 8_192;

/**
 * Ordered default fallback chain. `gpt-oss-120b` was removed on 2026-09-08
 * after repeated production 404s. `gpt-oss-20b` remains useful for ordinary
 * text agents but is intentionally not eligible for high-output plans.
 */
export const DEFAULT_FREE_TEXT_MODELS: readonly string[] = Object.freeze([
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

/** Normalize a comma-separated model list to concrete ids. */
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

/** Remove known-dead ids while preserving operator order and de-duplicating. */
export function removeRetiredTextModels(models: string[]): string[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (RETIRED_FREE_TEXT_MODELS.has(model) || seen.has(model)) return false;
    seen.add(model);
    return true;
  });
}

/**
 * Return the free candidates that are suitable for the requested structured
 * output size. Unknown/custom models remain eligible for ordinary agents, but
 * are not trusted with a >8k structured response until explicitly admitted.
 */
export function eligibleFreeTextModels(models: string[], maxOutputTokens: number): string[] {
  if (maxOutputTokens <= ORDINARY_STRUCTURED_OUTPUT_TOKENS) return [...models];
  return models.filter((model) => LARGE_STRUCTURED_FREE_TEXT_MODELS.has(model));
}

/**
 * Resolve the ordered free text-model chain.
 *
 * Precedence: `FREELLMAPI_TEXT_MODELS` (comma list) -> `FREELLMAPI_TEXT_MODEL`
 * (single id, temporary back-compat) -> built-in defaults. Known-retired ids are
 * always removed so an old production variable cannot resurrect a dead pin.
 */
export function resolveTextModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = clean(env["FREELLMAPI_TEXT_MODELS"])
    ?? clean(env["FREELLMAPI_TEXT_MODEL"])
    ?? DEFAULT_FREE_TEXT_MODELS.join(",");
  const models = removeRetiredTextModels(assertConcreteTextModels(raw));
  if (models.length === 0) {
    throw new Error("FREELLMAPI_TEXT_MODELS contains no serviceable model after retired pins are removed");
  }
  return models;
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
