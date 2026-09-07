import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { freeVisionTripped, recordFreeVisionResult, resetVisionRouteHealth } from "../src/vision-route-health.ts";

beforeEach(() => resetVisionRouteHealth());

test("the breaker trips after two consecutive optional vision failures", () => {
  assert.equal(freeVisionTripped(), false);
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), false, "one failure is not enough");
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), true);
});

test("a success cannot close a breaker that already tripped in this run", () => {
  recordFreeVisionResult(false);
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), true);
  recordFreeVisionResult(true);
  assert.equal(freeVisionTripped(), true);
});

test("success may reset failures only before the breaker trips", () => {
  for (let i = 0; i < 10; i++) {
    recordFreeVisionResult(false);
    recordFreeVisionResult(true);
  }
  assert.equal(freeVisionTripped(), false);
});

test("explicit reset starts a fresh route-health run", () => {
  recordFreeVisionResult(false);
  recordFreeVisionResult(false);
  assert.equal(freeVisionTripped(), true);
  resetVisionRouteHealth();
  assert.equal(freeVisionTripped(), false);
});
