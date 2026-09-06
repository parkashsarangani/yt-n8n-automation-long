import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { freeVisionTripped, recordFreeVisionResult, resetVisionRouteHealth } from "../src/vision-route-health.ts";

beforeEach(() => resetVisionRouteHealth());

test("the breaker trips after two consecutive FreeLLMAPI vision failures", () => {
  assert.equal(freeVisionTripped(), false);
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), false, "one failure is not enough");
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), true);
});

test("a single success closes the breaker again", () => {
  recordFreeVisionResult(false);
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), true);
  recordFreeVisionResult(true);
  assert.equal(freeVisionTripped(), false);
});

test("interleaved failures never accumulate to a trip", () => {
  for (let i = 0; i < 10; i++) {
    recordFreeVisionResult(false);
    recordFreeVisionResult(true);
  }
  assert.equal(freeVisionTripped(), false);
});
