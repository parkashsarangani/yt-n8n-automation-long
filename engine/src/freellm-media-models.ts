/**
 * Explicit ordered free media-model chains for the shared FreeLLMAPI instance.
 *
 * The Long project speaks to exactly one media aggregation layer — FreeLLMAPI —
 * which owns every provider credential (Cloudflare, Pollinations, NVIDIA,
 * SiliconFlow, Hugging Face, ...). Long only needs:
 *
 *   FREELLMAPI_BASE_URL       (already configured)
 *   FREELLMAPI_API_KEY        (already configured)
 *   FREELLMAPI_IMAGE_MODELS   comma list of concrete image model ids
 *   FREELLMAPI_VIDEO_MODELS   comma list of concrete FREE-VIDEO ALLOWLIST ids
 *
 * Same rules as the free text chain (see llm-routing.ts):
 *   - trim, drop empties, dedupe, preserve order;
 *   - reject `auto` / `auto:*` anywhere — deterministic cost/capability control
 *     is the whole point, and `auto` lets the gateway silently pick a provider;
 *   - an empty list is valid. For video an empty list is the SAFE default: it
 *     means "no free generated-video route", not "spend money".
 *
 * There is deliberately no built-in default list. A model only becomes a
 * production default after the manual `Free Media Bake-off` workflow proves it
 * returns valid media at zero out-of-pocket cost for the current account.
 */

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalise a `,`-separated media model list to concrete ordered ids.
 * Throws on an `auto` / `auto:*` entry. An empty / unset value yields `[]`.
 */
export function assertConcreteMediaModels(raw: string | string[] | undefined, envVar: string): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of Array.isArray(raw) ? raw : raw.split(",")) {
    const id = value.trim();
    if (!id) continue;
    if (/^auto(?::|$)/i.test(id)) {
      throw new Error(`${envVar} may not contain auto routing ('${id}'); pin concrete media model ids`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function resolveFreeImageModels(env: NodeJS.ProcessEnv = process.env): string[] {
  return assertConcreteMediaModels(clean(env["FREELLMAPI_IMAGE_MODELS"]), "FREELLMAPI_IMAGE_MODELS");
}

export function resolveFreeVideoModels(env: NodeJS.ProcessEnv = process.env): string[] {
  return assertConcreteMediaModels(clean(env["FREELLMAPI_VIDEO_MODELS"]), "FREELLMAPI_VIDEO_MODELS");
}

/** Optional fixed clip length for free video requests. Empty = let the model choose. */
export function resolveFreeVideoDurationSec(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const parsed = Number(clean(env["FREELLMAPI_VIDEO_DURATION_SEC"]));
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 120 ? Math.floor(parsed) : undefined;
}

export function freeLlmMediaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (clean(env["FREELLMAPI_BASE_URL"]) ?? "http://freellmapi:3001/v1").replace(/\/+$/, "");
}
