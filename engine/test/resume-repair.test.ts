import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";
import { MAX_ATTEMPTS_BEFORE_ACCEPTING } from "../src/workers/watchability-release.ts";

test("retry resumes preserved outputs before restarting automatic repair", async () => {
  const calls: string[] = [];
  const presets = { draft_script: "preserved-script" };
  const state = { finished: true, error: "failed", graph: "graph", presetOutputs: presets };
  const service = Object.create(VidGenService.prototype);
  service.runs = new Map([["run-test", state]]);
  service.resolveRunGraph = (graph: string) => graph;
  service.executor = { resume: async (_graph: string, id: string, _decisions: unknown, opts: { presetOutputs: unknown }) => {
    assert.equal(id, "run-test");
    assert.equal(opts.presetOutputs, presets);
    calls.push("resume");
  } };
  service.drive = async (_id: string, fn: () => Promise<void>) => { await fn(); calls.push("drive-finished"); };
  service.driveUnattended = async () => { calls.push("repair"); };
  await service.retry("run-test");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["resume", "drive-finished", "repair"]);
  assert.equal(state.error, null);
});

test("driveUnattended's own retry loop never calls the public retry() -- no exponential fan-out", async () => {
  // Production incident: retry() chains driveUnattended() on completion, and
  // driveUnattended()'s loop used to call retry() to resume a blocked run.
  // Every iteration spawned a brand-new, independent, unbounded driveUnattended()
  // loop (fresh round counter, so its own "give up" ceiling never fired), and
  // those fanned out exponentially -- thousands of concurrent retries in
  // minutes, racing a persisted per-run counter (the script revision `attempt`
  // field) past its schema ceiling and permanently wedging the run. The loop
  // must call the internal, non-chaining resumeFailedRun() instead.
  const calls: string[] = [];
  const state = { finished: true, error: null as string | null, graph: "graph" };
  const service = Object.create(VidGenService.prototype);
  service.runs = new Map([["run-test", state]]);
  service.getRun = () => ({
    status: "blocked",
    failures: [{ node_id: "draft_script", error: "payload does not satisfy some_schema@1.0.0: /attempt must be <= 6" }],
  });
  service.retry = async () => { calls.push("retry-CALLED (bug: would spawn a nested driveUnattended)"); };
  service.resumeFailedRun = async () => { calls.push("resumeFailedRun"); state.finished = true; };

  await service.driveUnattended("run-test");

  const expectedRounds = MAX_ATTEMPTS_BEFORE_ACCEPTING - 1;
  assert.deepEqual(calls, Array(expectedRounds).fill("resumeFailedRun"));
});
