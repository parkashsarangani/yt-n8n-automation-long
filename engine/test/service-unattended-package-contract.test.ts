import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { VidGenService } from "../src/service.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Regression coverage for the production failure in run `fcb88a7e`:
 * VidGenService.driveUnattended() treated every watchability_release failure
 * identically, so three separate PACKAGE_CONTRACT blocks each spent a
 * script-regeneration attempt -- including the final one, which wastefully
 * "restored the best of 5" script attempts for a defect no script content
 * could ever have fixed. This exercises the REAL private driveUnattended()
 * method on a REAL VidGenService (not just the pure classifier helper in
 * growth-package-contract.ts), by fabricating the exact blocked RunState the
 * production run produced and spying on the executor/retry calls it makes.
 */
async function makeService(): Promise<VidGenService> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "vidgen-unattended-"));
  return VidGenService.create({
    root: ROOT,
    dataDir,
    envFile: path.join(dataDir, ".env-does-not-exist"),
  });
}

const GRAPH = "illustrated_story@7";

function seedBlockedRun(service: VidGenService, runId: string, failures: Array<{ node_id: string; error: string }>, outputs: Record<string, string> = {}) {
  (service as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
    runId,
    brief: "test run",
    createdAt: new Date().toISOString(),
    graph: GRAPH,
    active: new Set(),
    completedOutputs: new Map(),
    finished: true,
    error: null,
    last: {
      run_id: runId,
      graph: GRAPH,
      status: "blocked",
      outputs,
      waiting: [],
      failures: failures.map((f) => ({ ...f, transformation: f.node_id })),
      blocked: [],
    },
  });
}

function spyExecutor(service: VidGenService) {
  const calls = { regenerateNode: 0, pinNodeOutput: 0 };
  (service as unknown as { executor: unknown }).executor = {
    regenerateNode: async () => { calls.regenerateNode++; },
    pinNodeOutput: async () => { calls.pinNodeOutput++; },
  };
  return calls;
}

function spyRetry(service: VidGenService, onRetry: () => void) {
  let calls = 0;
  (service as unknown as { retry: (id: string) => Promise<void> }).retry = async () => {
    calls++;
    onRetry();
  };
  return () => calls;
}

test("a residual PACKAGE_CONTRACT block never spends a script-regeneration attempt", async () => {
  const service = await makeService();
  const runId = "run_package_contract_unattended";
  seedBlockedRun(service, runId, [
    { node_id: "watchability_release", error: "watchability release blocked (PACKAGE_CONTRACT): selected thumbnail does not exactly match the curiosity variant" },
  ]);
  const executorCalls = spyExecutor(service);
  const retryCalls = spyRetry(service, () => {
    throw new Error("retry() must never be called for a PACKAGE_CONTRACT failure -- it cannot repair a deterministic package defect");
  });

  await (service as unknown as { driveUnattended: (id: string) => Promise<void> }).driveUnattended(runId);

  assert.equal(executorCalls.regenerateNode, 0, "a package defect must never trigger draft_script regeneration");
  assert.equal(executorCalls.pinNodeOutput, 0, "a package defect must never trigger the best-of-N restore");
  assert.equal(retryCalls(), 0, "a package defect must not be blindly retried -- it is a pure-function failure that reproduces identically");
});

test("a growth_package_release node failure (not just watchability_release's defense-in-depth check) is also never retried", async () => {
  const service = await makeService();
  const runId = "run_package_contract_release_node";
  seedBlockedRun(service, runId, [
    { node_id: "growth_package_release", error: "growth package release blocked (PACKAGE_CONTRACT): selected title has no resolvable package family" },
  ]);
  const executorCalls = spyExecutor(service);
  const retryCalls = spyRetry(service, () => {});

  await (service as unknown as { driveUnattended: (id: string) => Promise<void> }).driveUnattended(runId);

  assert.equal(executorCalls.regenerateNode, 0);
  assert.equal(executorCalls.pinNodeOutput, 0);
  assert.equal(retryCalls(), 0);
});

test("a visual_asset_release block triggers targeted assets regeneration, not script regeneration", async () => {
  const service = await makeService();
  const runId = "run_visual_asset_release_regen";
  seedBlockedRun(service, runId, [
    { node_id: "visual_asset_release", error: "visual asset release blocked before render: 1/7 scene(s) contain fallback imagery (14%); maximum is 10%" },
  ]);

  const regenNodeIds: string[] = [];
  (service as unknown as { executor: unknown }).executor = {
    regenerateNode: async (_graph: unknown, _runId: string, nodeId: string) => { regenNodeIds.push(nodeId); },
    pinNodeOutput: async () => { throw new Error("visual_asset_release is not a watchability best-of-N situation"); },
  };
  let retried = 0;
  (service as unknown as { retry: (id: string) => Promise<void> }).retry = async () => {
    retried++;
    // Resolve on the first regeneration: the free path is non-deterministic,
    // so a real regeneration attempt can genuinely produce a passing manifest.
    (service as unknown as { runs: Map<string, { last: { failures: unknown[] } }> }).runs.get(runId)!.last.failures = [];
  };

  await (service as unknown as { driveUnattended: (id: string) => Promise<void> }).driveUnattended(runId);

  assert.deepEqual(regenNodeIds, ["visual_assets"], "must regenerate the RFC 0010 beat resolver specifically, never draft_script");
  assert.equal(retried, 1, "must actually re-execute after regeneration, not just log and give up");
});

test("visual_asset_release regeneration is bounded and gives up cleanly once exhausted", async () => {
  const service = await makeService();
  const runId = "run_visual_asset_release_exhausted";
  seedBlockedRun(service, runId, [
    { node_id: "visual_asset_release", error: "visual asset release blocked before render: 1/7 scene(s) contain fallback imagery (14%); maximum is 10%" },
  ]);

  let regenCalls = 0;
  (service as unknown as { executor: unknown }).executor = {
    regenerateNode: async () => { regenCalls++; },
    pinNodeOutput: async () => { throw new Error("must not fire for visual_asset_release"); },
  };
  let retried = 0;
  // Every regeneration keeps failing identically -- the bounded ceiling must
  // still stop the loop rather than retry forever.
  (service as unknown as { retry: (id: string) => Promise<void> }).retry = async () => { retried++; };

  await (service as unknown as { driveUnattended: (id: string) => Promise<void> }).driveUnattended(runId);

  assert.equal(regenCalls, 3, "default maxVisualReleaseRegens is 3 -- must stop there, not loop forever");
  assert.equal(retried, 3);
});

test("a genuine WATCHABILITY_BLOCKED score deficiency still regenerates the script exactly like before", async () => {
  const service = await makeService();
  const runId = "run_watchability_blocked_unattended";

  const store = (service as unknown as { store: { put: (a: unknown) => Promise<{ artifact: { artifact_id: string } }> } }).store;
  const report = await store.put({
    schema_id: "watchability_report",
    payload: {
      verdict: "revise",
      scores: {
        hook: 0.78,
        first_30_fidelity: 0.90,
        package_fidelity: 0.90,
        suspense: 0.80,
        watchability: 0.85,
        entertainment: 0.80,
        payoff: 0.80,
        youtube_fit: 0.80,
      },
      weakest_dimension: "hook",
      summary: "The opening line does not create a strong enough unanswered question in the first few seconds.",
      abandon_recommended: false,
      abandon_reason: "",
    },
    produced_by: { transformation: "watchability_critic", version: "1", run_id: runId, provider: null },
  });

  seedBlockedRun(
    service,
    runId,
    [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 1): hook=0.78 (requires 0.82)" }],
    { draft_script: "sha256:" + "1".repeat(64), watchability_report: report.artifact.artifact_id },
  );

  const executorCalls = spyExecutor(service);
  let retried = false;
  spyRetry(service, () => {
    retried = true;
    // Stop the loop on the next iteration: driveUnattended re-reads getRun()
    // after retry(), so make the same run report zero failures afterward.
    const state = (service as unknown as { runs: Map<string, { last: { failures: unknown[] } }> }).runs.get(runId)!;
    state.last.failures = [];
  });

  await (service as unknown as { driveUnattended: (id: string) => Promise<void> }).driveUnattended(runId);

  assert.equal(executorCalls.regenerateNode, 1, "a genuine watchability score deficiency must still regenerate the script");
  assert.equal(executorCalls.pinNodeOutput, 0, "only one failed attempt exists so far -- best-of-N restore must not fire yet");
  assert.ok(retried, "the node must actually be re-executed after regeneration");
});
