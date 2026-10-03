/**
 * The channel's video format (operator decision 2026-09-29: move to vertical
 * Shorts/Reels, keep long-form DORMANT -- "we may return to long format one
 * day", so nothing long-form is deleted, only switched off).
 *
 * VIDEO_FORMAT picks what NEW drafts are rendered as. Unset means "long", so
 * every long-form path behaves exactly as before. Checks on an existing video
 * (QA, the editor-cut intake, publish) read the format from the video's own
 * geometry via formatOfGeometry(), never from this setting -- an episode
 * drafted before a switch must still pass when its cut comes back after it.
 */

export type VideoFormat = "long" | "short";

export interface FormatSpec {
  format: VideoFormat;
  aspect: "16:9" | "9:16";
  width: number;
  height: number;
  /** Shortest length the studio asks for; null = no floor (long-form). A target, not a QA gate. */
  minDurationSec: number | null;
  /** Hard ceiling on the final video's length, enforced by QA; null = no cap (long-form). */
  maxDurationSec: number | null;
}

/**
 * The longest vertical cut still published and cross-posted as a Short
 * (YouTube's Shorts limit). FORMATS.short's 60-75 s is the GENERATION target
 * only -- an editor's final cut is never held to it (operator 2026-10-03).
 */
export const SHORTS_MAX_PUBLISH_SEC = 180;

export const FORMATS: Record<VideoFormat, FormatSpec> = {
  long: { format: "long", aspect: "16:9", width: 1920, height: 1080, minDurationSec: null, maxDurationSec: null },
  // 60-75 s (operator decision 2026-09-29). 75 s still fits every target
  // platform with room: Facebook Reels, the tightest, allows 90 s.
  short: { format: "short", aspect: "9:16", width: 1080, height: 1920, minDurationSec: 60, maxDurationSec: 75 },
};

export function videoFormat(env: NodeJS.ProcessEnv = process.env): VideoFormat {
  const raw = env["VIDEO_FORMAT"]?.trim().toLowerCase();
  if (!raw || raw === "long") return "long";
  if (raw === "short") return "short";
  throw new Error(`VIDEO_FORMAT must be "long" or "short", got "${raw}"`);
}

export function formatSpec(env: NodeJS.ProcessEnv = process.env): FormatSpec {
  return FORMATS[videoFormat(env)];
}

/** Which production format a video's geometry is, or null if it is neither. */
export function formatOfGeometry(width: number, height: number): VideoFormat | null {
  for (const spec of Object.values(FORMATS)) {
    if (spec.width === width && spec.height === height) return spec.format;
  }
  return null;
}
