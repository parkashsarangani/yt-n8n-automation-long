/**
 * Capability-specific free-first fallback policy.
 *
 * One explicit, deliberately ASYMMETRIC cost-control policy. Strong free
 * providers are always tried first. Paid fallbacks are permitted only where a
 * flag says so, and paid *video generation* is blocked by default in code.
 *
 *   TEXT       free chain -> paid OpenAI text        (PAID_TEXT_FALLBACK,   default ON)
 *   VISION QA  metadata screen -> free VLM chain
 *              -> paid OpenAI vision                  (PAID_VISION_FALLBACK, default ON)
 *   IMAGE      cache/reuse/stock/free-gen
 *              -> paid image generation               (PAID_IMAGE_FALLBACK,  default ON)
 *   VIDEO      cache/reuse/free stock/free video
 *              -> semantic NON-VIDEO representation.
 *              NEVER paid video generation.           (PAID_VIDEO_FALLBACK,  default OFF)
 *
 * This is four booleans plus one explicit free-VLM id list. No policy DSL, no
 * generic fallback graph, no provider scoring. If you find yourself adding a
 * fifth knob, stop and reconsider.
 */

export interface FallbackPolicy {
  /** After the free text chain is exhausted, call the paid OpenAI text model. */
  paidTextFallback: boolean;
  /** After the free VLM chain is exhausted, call paid OpenAI vision QA. */
  paidVisionFallback: boolean;
  /** After free image sources are exhausted, allow paid image generation. */
  paidImageFallback: boolean;
  /**
   * Allow paid video generation (Kling / Fal) as a fallback. HARD-OFF by
   * default: normal automated production must never invoke a paid video
   * generator, even when FAL_KEY and a video model are configured.
   */
  paidVideoFallback: boolean;
  /**
   * Ordered list of concrete free vision-capable model ids to try before any
   * paid vision QA. May be empty (then metadata screen -> paid directly).
   * Every id here must still pass the deterministic image-perception canary
   * before its scores are trusted.
   */
  freeVisionModels: string[];
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Parse a boolean flag. `1/true/yes/on` -> true, `0/false/no/off` -> false,
 * anything else (unset, empty, junk) -> `fallbackValue`.
 */
export function policyFlag(value: string | undefined, fallbackValue: boolean): boolean {
  const v = clean(value)?.toLowerCase();
  if (v === undefined) return fallbackValue;
  if (/^(1|true|yes|on)$/.test(v)) return true;
  if (/^(0|false|no|off)$/.test(v)) return false;
  return fallbackValue;
}

export function resolveFreeVisionModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = clean(env["FREE_VISION_MODELS"]);
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .filter((id) => !/^auto(?::|$)/i.test(id));
}

export function fallbackPolicy(env: NodeJS.ProcessEnv = process.env): FallbackPolicy {
  return {
    paidTextFallback: policyFlag(env["PAID_TEXT_FALLBACK"], true),
    paidVisionFallback: policyFlag(env["PAID_VISION_FALLBACK"], true),
    paidImageFallback: policyFlag(env["PAID_IMAGE_FALLBACK"], true),
    // Code default OFF. Only an explicit truthy PAID_VIDEO_FALLBACK enables it.
    paidVideoFallback: policyFlag(env["PAID_VIDEO_FALLBACK"], false),
    freeVisionModels: resolveFreeVisionModels(env),
  };
}

/**
 * The one hard budget rule, isolated so it is trivially greppable and testable:
 * normal production resolution may invoke a paid video generator ONLY when
 * PAID_VIDEO_FALLBACK is explicitly enabled.
 */
export function paidVideoGenerationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return fallbackPolicy(env).paidVideoFallback;
}
