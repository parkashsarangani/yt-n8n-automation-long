import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WatchabilityLedger,
  watchabilityEvaluator,
  watchabilityFingerprint,
  type WatchabilityFingerprintInput,
} from "../src/watchability-ledger.ts";
import { WATCHABILITY_POLICY_VERSION } from "../src/watchability-policy.ts";

const BASE: WatchabilityFingerprintInput = {
  script_artifact_id: "sha256:" + "a".repeat(64),
  evaluator: {
    critic_prompt_ref: "watchability_critic@5",
    critic_model_capability: "reasoning_high",
    critic_effort: "high",
    critic_prefer_paid: true,
    policy_version: WATCHABILITY_POLICY_VERSION,
  },
  duration_profile: "long_form:180:avg0.75:f300.8:susp0.75",
};

function withField<K extends keyof WatchabilityFingerprintInput>(k: K, v: WatchabilityFingerprintInput[K]): WatchabilityFingerprintInput {
  return { ...BASE, [k]: v };
}

test("watchabilityFingerprint is deterministic and sensitive to every immutable input", () => {
  assert.equal(watchabilityFingerprint(BASE), watchabilityFingerprint({ ...BASE }));
  assert.match(watchabilityFingerprint(BASE), /^wf_[0-9a-f]{40}$/);

  const fp = watchabilityFingerprint(BASE);
  assert.notEqual(fp, watchabilityFingerprint(withField("script_artifact_id", "sha256:" + "b".repeat(64))));
  assert.notEqual(fp, watchabilityFingerprint(withField("duration_profile", "compact:75:avg0.73:f300.7:susp0.65")));
  for (const patch of [
    { critic_prompt_ref: "watchability_critic@4" },
    { critic_model_capability: "reasoning_fast" },
    { critic_effort: "medium" },
    { critic_prefer_paid: false },
    { policy_version: "different-floors" },
  ] as const) {
    assert.notEqual(fp, watchabilityFingerprint(withField("evaluator", { ...BASE.evaluator, ...patch })));
  }
});

test("watchabilityEvaluator reads the critic agent definition and pins the policy version", () => {
  const ev = watchabilityEvaluator({ prompt: "watchability_critic@5", model: { capability: "reasoning_high", effort: "high", prefer_paid_reasoning: true } });
  assert.deepEqual(ev, {
    critic_prompt_ref: "watchability_critic@5",
    critic_model_capability: "reasoning_high",
    critic_effort: "high",
    critic_prefer_paid: true,
    policy_version: WATCHABILITY_POLICY_VERSION,
  });
});

test("the ledger reuses the first adjudicated decision and never lets a later roll overwrite it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wledger-"));
  const ledger = await WatchabilityLedger.open(dir);

  assert.equal(await ledger.get(watchabilityFingerprint(BASE)), null);

  const first = await ledger.setCanonical(BASE, "sha256:report-PASS", "single");
  assert.equal(first.canonical_report_id, "sha256:report-PASS");
  assert.equal(first.adjudication, "single");

  // A later run of the identical content rolls the critic differently and it
  // fails — the canonical decision must not move.
  const second = await ledger.setCanonical(BASE, "sha256:report-FAIL", "single");
  assert.equal(second.canonical_report_id, "sha256:report-PASS", "first writer wins; the canonical decision is immutable");

  const got = await ledger.get(watchabilityFingerprint(BASE));
  assert.equal(got?.canonical_report_id, "sha256:report-PASS");
});

test("the ledger records every raw critic report seen for a fingerprint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wledger-"));
  const ledger = await WatchabilityLedger.open(dir);

  await ledger.appendRaw(BASE, "sha256:raw-1");
  await ledger.appendRaw(BASE, "sha256:raw-2");
  await ledger.appendRaw(BASE, "sha256:raw-2"); // dedup
  await ledger.setCanonical(BASE, "sha256:raw-2", "median_of_3");

  const entry = await ledger.get(watchabilityFingerprint(BASE));
  assert.deepEqual(entry?.raw_report_ids, ["sha256:raw-1", "sha256:raw-2"]);
  assert.equal(entry?.canonical_report_id, "sha256:raw-2");
  assert.equal(entry?.adjudication, "median_of_3");
});

test("a different evaluator fingerprint is a separate ledger entry, not a carried-forward approval", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wledger-"));
  const ledger = await WatchabilityLedger.open(dir);
  await ledger.setCanonical(BASE, "sha256:old-approval", "single");

  // Thresholds changed -> new policy version -> the old approval does not apply.
  const newPolicy = withField("evaluator", { ...BASE.evaluator, policy_version: "2027-01-floors-v3" });
  assert.equal(await ledger.get(watchabilityFingerprint(newPolicy)), null);
});
