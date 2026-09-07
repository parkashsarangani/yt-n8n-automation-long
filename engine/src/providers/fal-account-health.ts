import { ProviderError } from "../provider.ts";

let terminalReason: string | null = null;

function sanitize(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function isTerminalFalAccountResponse(status: number, body: string): boolean {
  if (status === 402) return true;
  if (status !== 401 && status !== 403) return false;
  return /(locked|exhausted(?:\s+balance)?|suspended|payment\s+required|insufficient\s+(?:funds|balance|credits?))/i.test(body);
}

/** Latch an account/billing failure that cannot recover inside the current run. */
export function recordFalHttpFailure(status: number, body: string): boolean {
  if (!isTerminalFalAccountResponse(status, body)) return false;
  if (!terminalReason) {
    const detail = sanitize(body);
    terminalReason = `fal account unavailable: HTTP ${status}${detail ? `: ${detail}` : ""}`;
    console.warn(`[fal-account-health] ${terminalReason}; further paid fal calls are disabled for this run`);
  }
  return true;
}

export function falAccountLocked(): boolean {
  return terminalReason !== null;
}

export function falAccountReason(): string | null {
  return terminalReason;
}

export function assertFalAccountAvailable(): void {
  if (terminalReason) throw new ProviderError(terminalReason);
}

/** Used by candidate loops to stop immediately after a provider latched. */
export function isFalAccountLockedError(error: unknown): boolean {
  return falAccountLocked() && error instanceof Error && error.message.includes("fal account unavailable");
}

/** Test/new-process hook. */
export function resetFalAccountHealth(): void {
  terminalReason = null;
}
