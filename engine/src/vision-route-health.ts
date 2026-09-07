/**
 * Process-local circuit breaker retained for any future non-direct vision route.
 *
 * A route that has been proven unable/unreliable for image requests must stay
 * disabled for the rest of the process/run. A later HTTP 200 is not evidence of
 * recovery: the FreeLLMAPI incident that motivated this breaker returned
 * fabricated 200s from a text-only fallback and those successes repeatedly
 * erased the failure count. Only an explicit reset/new process may close a
 * tripped breaker.
 *
 * RFC 0010 visual QA no longer calls FreeLLMAPI at all; this is a defensive
 * backstop for any future optional/free vision route.
 */

const TRIP_THRESHOLD = (() => {
  const raw = Number(process.env["FREE_VISION_TRIP_THRESHOLD"]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
})();

export const FREE_VISION_ATTEMPT_TIMEOUT_MS = (() => {
  const raw = Number(process.env["FREE_VISION_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
})();

let consecutiveFailures = 0;
let tripped = false;

export function freeVisionTripped(): boolean {
  return tripped;
}

/** Record the outcome of an optional/free vision attempt. Once tripped, sticky. */
export function recordFreeVisionResult(ok: boolean): void {
  if (tripped) return;
  if (ok) {
    consecutiveFailures = 0;
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures >= TRIP_THRESHOLD) {
    tripped = true;
    console.warn(
      `[vision-route-health] optional vision route failed ${consecutiveFailures}x; ` +
        "route disabled for the rest of this run",
    );
  }
}

/** Test/new-run hook. */
export function resetVisionRouteHealth(): void {
  consecutiveFailures = 0;
  tripped = false;
}
