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
      target_duration_sec: 540,
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

test("startManualRun can reuse a stored voice artifact, and rejects a non-voice one", async () => {
  const service = await makeService();
  const store = (service as unknown as { store: { put: (a: unknown) => Promise<{ artifact: { artifact_id: string } }> } }).store;
  const notVoice = await store.put({
    schema_id: "intent",
    payload: { brief: "A perfectly valid intent artifact that is not a voice artifact.", target_duration_sec: 180 },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });
  const manual = {
    title: "The Dose That Was Never Signed For",
    hook: "The hospital drug cabinet logged a dose for bed twelve. Bed twelve had been empty since Monday.",
    narration: "Mara checks the cabinets every night.\n\nThat line was impossible.\n\nShe pulled the week of logs.",
  };

  const priorKey = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "sk-test";
  try {
    await assert.rejects(
      () => (service as unknown as { startManualRun: (i: unknown, d: number, o: unknown) => Promise<string> })
        .startManualRun(manual, 180, { reuseVoiceArtifactId: notVoice.artifact.artifact_id }),
      /is not a stored voice artifact/,
    );
  } finally {
    if (priorKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = priorKey;
  }
});

test("operator one-shot watchability re-grade: regenerates only the report, once, manual-only, when blocked at watchability", async () => {
  const service = await makeService();
  const store = (service as unknown as { store: { put: (a: unknown) => Promise<{ artifact: { artifact_id: string } }> } }).store;
  const humanScript = await store.put({
    schema_id: "script",
    payload: { scenes: [
      { scene_index: 0, act_index: 0, point: "open", narration: "An operator wrote this exact line and it did not change." },
      { scene_index: 1, act_index: 1, point: "turn", narration: "The re-grade must never touch it." },
    ], word_count: 20 },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });
  const runId = "run_manual_rescore";
  (service as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
    runId, brief: "manual", createdAt: new Date().toISOString(),
    graph: "illustrated_story@9",
    active: new Set(), completedOutputs: new Map(),
    presetOutputs: {}, manualPresetOutputs: { draft_script: humanScript.artifact.artifact_id, voice: "sha256:" + "9".repeat(64) },
    manualWatchabilityRescores: 0,
    finished: true, error: null,
    last: {
      run_id: runId, graph: "illustrated_story@9", status: "blocked",
      outputs: { draft_script: humanScript.artifact.artifact_id, watchability_report: "sha256:" + "7".repeat(64) },
      waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 1): payoff=0.72 (requires 0.75)" }], blocked: [],
    },
  });

  const calls: Array<[string, string]> = [];
  (service as unknown as { executor: unknown }).executor = {
    regenerateNode: async (_g: unknown, _r: string, nodeId: string, reason: string) => { calls.push([nodeId, reason]); },
    resume: async () => ({ status: "blocked", outputs: {}, waiting: [], failures: [], blocked: [] }),
  };
  (service as unknown as { drive: unknown }).drive = async (_id: string, fn: () => Promise<unknown>) => { await fn(); };
  (service as unknown as { driveUnattended: unknown }).driveUnattended = async () => {};

  await (service as unknown as { rescoreManualWatchability: (id: string) => Promise<void> }).rescoreManualWatchability(runId);
  assert.deepEqual(calls, [["watchability_report", "operator_requested_rescore"]], "re-grade recomputes ONLY the report, with an auditable reason");

  // restored presets (incl. the reused voice) so the cascade keeps them intact
  const st = (service as unknown as { runs: Map<string, Record<string, unknown>> }).runs.get(runId)!;
  assert.ok((st["presetOutputs"] as Record<string, string>)["voice"], "the reused voice preset is restored before the retry cascade");
  st["finished"] = true;
  st["last"] = { run_id: runId, graph: "illustrated_story@9", status: "blocked", outputs: { draft_script: humanScript.artifact.artifact_id }, waiting: [], failures: [{ node_id: "watchability_release", error: "still failing" }], blocked: [] };

  // second re-grade is refused
  await assert.rejects(
    () => (service as unknown as { rescoreManualWatchability: (id: string) => Promise<void> }).rescoreManualWatchability(runId),
    /already used its 1 operator watchability re-grade/,
  );
});

test("watchability re-grade is refused for a non-manual run and when not blocked at watchability", async () => {
  const service = await makeService();
  const runId = "run_ai_rescore";
  seedBlockedRun(service, runId, [{ node_id: "watchability_release", error: "blocked" }], { draft_script: "sha256:" + "1".repeat(64) });
  (service as unknown as { runs: Map<string, { graph: string }> }).runs.get(runId)!.graph = "illustrated_story@9";
  await assert.rejects(
    () => (service as unknown as { rescoreManualWatchability: (id: string) => Promise<void> }).rescoreManualWatchability(runId),
    /only for operator-authored/,
  );
});
