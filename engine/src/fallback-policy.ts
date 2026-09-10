/** Paid text fallback policy for the free-first reasoning router. */
export interface FallbackPolicy {
  paidTextFallback: boolean;
}

export function policyFlag(value: string | undefined, fallbackValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallbackValue;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return fallbackValue;
}

export function fallbackPolicy(env: NodeJS.ProcessEnv = process.env): FallbackPolicy {
  return { paidTextFallback: policyFlag(env["PAID_TEXT_FALLBACK"], true) };
}
