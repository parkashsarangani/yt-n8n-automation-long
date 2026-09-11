/** Delivery diagnostics, not a substitute for listening or a persuasion score. */
export function narrationPace(text: string, durationSec: number): number | null {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (!words || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return Math.round(words * 600 / durationSec) / 10;
}

export function deliverySetting(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key]?.trim() || fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return value;
}
