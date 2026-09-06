/**
 * Process-local circuit breaker for the shared FreeLLMAPI vision route.
 *
 * The shared `auto:smart` multimodal route is frequently unavailable for image
 * requests. Every vision QA call would otherwise pay the full per-request
 * timeout to rediscover that before failing open to direct OpenAI — tens of
 * minutes across a benchmark or smoke run.
 *
 * After a small number of consecutive FreeLLMAPI vision failures the breaker
 * trips and callers skip straight to the direct route for the rest of the
 * process. A single success closes it again. This never changes *which*
 * provider is authoritative, only whether we bother trying the free route
 * first.
 */

const TRIP_THRESHOLD = (() => {
  const raw = Number(process.env["FREE_VISION_TRIP_THRESHOLD"]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
})();

/** Shorter timeout for the *first* (free) attempt so a dead route is cheap to
 * detect; the direct attempt keeps the full budget. Overridable. */
export const FREE_VISION_ATTEMPT_TIMEOUT_MS = (() => {
  const raw = Number(process.env["FREE_VISION_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
})();

let consecutiveFailures = 0;

/** True when the free vision route has failed enough times in a row that
 * callers should skip it and go straight to the direct route. */
export function freeVisionTripped(): boolean {
  return consecutiveFailures >= TRIP_THRESHOLD;
}

/** Record the outcome of a FreeLLMAPI vision attempt. */
export function recordFreeVisionResult(ok: boolean): void {
  if (ok) {
    if (consecutiveFailures > 0) {
      console.warn("[vision-route-health] FreeLLMAPI vision recovered; breaker closed");
    }
    consecutiveFailures = 0;
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures === TRIP_THRESHOLD) {
    console.warn(
      `[vision-route-health] FreeLLMAPI vision failed ${consecutiveFailures}x in a row; ` +
        "skipping it for the rest of this run and using the direct route",
    );
  }
}

/** Test hook. */
export function resetVisionRouteHealth(): void {
  consecutiveFailures = 0;
}
