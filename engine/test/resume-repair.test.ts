import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";

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
