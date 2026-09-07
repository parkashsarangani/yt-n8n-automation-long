import { ProviderError } from "./provider.ts";

export const FREE_MEDIA_TERMINAL_PREFIX = "[free-media-terminal]";
export const FREE_MEDIA_AUTH_PREFIX = "[free-media-auth]";

const DAILY_IMAGE_CAPACITY = /(?:used up your daily free allocation|daily free allocation|10[,.]?000 neurons|daily (?:image )?quota.{0,40}(?:exhaust|limit|used)|quota.{0,40}(?:exhaust|used up))/i;

/**
 * Cloudflare Workers AI free allocation is a hard daily ceiling, not a
 * transient rate limit. Keep this marker stable because unattended recovery
 * reads persisted error strings after the original Error instance is gone.
 */
export class FreeMediaTerminalError extends ProviderError {
  override name = "FreeMediaTerminalError";

  constructor(message: string) {
    super(`${FREE_MEDIA_TERMINAL_PREFIX} ${message}`);
  }
}

/**
 * The shared FreeLLMAPI media gateway rejected the unified key itself (401/403).
 * This is a CONFIGURATION error — a typo'd or expired `FREELLMAPI_API_KEY` — not
 * a free-provider outage. It must stop the free media operation WITHOUT letting
 * a paid provider be tried as a "the free path is unavailable" fallback, exactly
 * as a bad key does on the free text chain.
 */
export class FreeMediaAuthError extends ProviderError {
  override name = "FreeMediaAuthError";

  constructor(message: string) {
    super(`${FREE_MEDIA_AUTH_PREFIX} ${message}`);
  }
}

export function isFreeMediaAuthFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return value instanceof FreeMediaAuthError || message.includes(FREE_MEDIA_AUTH_PREFIX);
}

export function isDailyFreeImageCapacityMessage(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return DAILY_IMAGE_CAPACITY.test(message);
}

export function isTerminalFreeMediaFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return value instanceof FreeMediaTerminalError
    || message.includes(FREE_MEDIA_TERMINAL_PREFIX)
    || isDailyFreeImageCapacityMessage(message);
}

/** Next Cloudflare daily-limit reset. Workers AI documents 00:00 UTC. */
export function nextUtcDailyReset(nowMs = Date.now()): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
}

const TEXT_RISK = /\b(?:clock|watch|timepiece|dial|calendar|date|sign|logo|label|screen|phone|tablet|book|document|paper|newspaper|letter|chart|poster|badge|uniform|receipt|ticket|menu|map|number|numeral|text|writing|handwriting)\b/i;

/**
 * The free image models observed in production often literalize textual props.
 * Prevent the avoidable first failure instead of spending quota and repairing
 * the same deterministic mistake afterwards.
 */
export function freeImagePrompt(prompt: string): string {
  if (!TEXT_RISK.test(prompt)) return prompt;
  return `${prompt} FREE-MODEL TEXT SAFETY: preserve the story beat without rendering readable marks. `
    + "If a clock, watch, timepiece or dial appears, show its back, edge, closed cover, silhouette, or crop/occlude the face completely; no ticks, hands, numerals, symbols, or dial markings. "
    + "Calendars and papers must be blank, folded, face-down, closed, edge-on, distant, or cropped so no grid/date/letters are visible. "
    + "Clothing, signs, devices, books, badges and objects must be plain and unbranded. No words, letters, numbers, logos, watermarks, glyphs, handwriting or readable symbols anywhere.";
}

export function semanticRecoveryPrompt(prompt: string, narration: string, reason: string): string {
  return `${prompt} SEMANTIC RECOVERY: the previous image contradicted the narration (${reason.slice(0, 280)}). `
    + `Preserve these narrated facts exactly: ${narration.slice(0, 500)}. `
    + "Keep person role, gender presentation, count, action, object ownership, location and causal relationship exactly as described. Do not substitute a different person or action. No readable text, letters, numbers, logos or labels.";
}
