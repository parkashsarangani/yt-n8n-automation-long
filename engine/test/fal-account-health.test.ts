import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  assertFalAccountAvailable,
  falAccountLocked,
  isTerminalFalAccountResponse,
  recordFalHttpFailure,
  resetFalAccountHealth,
} from "../src/providers/fal-account-health.ts";

beforeEach(() => resetFalAccountHealth());

test("402 and explicit locked/exhausted account responses are terminal", () => {
  assert.equal(isTerminalFalAccountResponse(402, "anything"), true);
  assert.equal(isTerminalFalAccountResponse(403, "User is locked. Reason: Exhausted balance."), true);
  assert.equal(isTerminalFalAccountResponse(401, "payment required"), true);
});

test("auth, quota and transient provider failures do not poison the account circuit", () => {
  assert.equal(isTerminalFalAccountResponse(401, "invalid api key"), false);
  assert.equal(isTerminalFalAccountResponse(403, "model not available on plan"), false);
  assert.equal(isTerminalFalAccountResponse(429, "rate limited"), false);
  assert.equal(isTerminalFalAccountResponse(503, "temporary outage"), false);
});

test("the first terminal response latches and later paid calls fail before a network attempt", () => {
  assert.equal(falAccountLocked(), false);
  assert.equal(recordFalHttpFailure(403, "User is locked. Reason: Exhausted balance."), true);
  assert.equal(falAccountLocked(), true);
  assert.throws(() => assertFalAccountAvailable(), /fal account unavailable: HTTP 403/i);
  recordFalHttpFailure(503, "later noise");
  assert.throws(() => assertFalAccountAvailable(), /Exhausted balance/i, "original terminal reason remains pinned");
});
