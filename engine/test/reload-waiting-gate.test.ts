/**
 * Which gate a run is parked on is derived from the graph, not stored, so a
 * reloaded run has to have it reconstructed.
 *
 * Found in production: after a deploy every waiting run came back with an
 * empty `waiting[]`. checkEditorReturns() selects runs with
 * `waiting.some(node_id === "editor_review")`, so it matched nothing and
 * reported "checked 0" while episodes sat in Drive. The engine restarts on
 * every deploy, several times a day, so the editor-return flow was effectively
 * dead — and silently, because "checked 0 runs" looks identical to "no runs
 * need checking". Every other test in this suite stubs listRuns(), which is
 * why none of them caught it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";
import { MemoryRunLog } from "../src/runlog.ts";

/** The real production graph's shape around the editor hand-off. */
const GRAPH = {
  graph_id: "illustrated_story",
  version: "15",
  nodes: [
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "render", transformation: "render", in: ["intent"] },
    { id: "editor_delivery", type: "human_gate", in: ["render"] },
    { id: "editor_package", transformation: "editor_package", in: ["editor_delivery"] },
    { id: "editor_review", type: "human_gate", in: ["editor_package"] },
    { id: "finalize_video", transformation: "finalize_video", in: ["editor_review", "render"] },
  ],
} as never;

async function reloadWith(done: Array<[string, string]>) {
  const runLog = new MemoryRunLog();
  for (const [node, output] of done) {
    await runLog.record({
      run_id: "run_reload01", graph_id: "illustrated_story@15", node_id: node,
      transformation: node, transformation_version: "1", inputs: [], output,
      status: "ok", attempt: 1, max_attempts: 1, started_at: new Date(0).toISOString(), duration_ms: 1,
    });
  }

  const service = Object.create(VidGenService.prototype);
  service.runs = new Map();
  service.graph = GRAPH;
  service.runLog = runLog;
  service.store = { get: async () => null };
  await service.reloadRuns();
  return service.getRun("run_reload01");
}

test("a run reloaded after a restart still knows it is parked at editor_review", async () => {
  const view = await reloadWith([
    ["intent", "sha256:intent"],
    ["render", "sha256:render"],
    ["editor_delivery", "sha256:render"],
    ["editor_package", "sha256:handoff"],
  ]);

  assert.equal(view.status, "waiting");
  assert.deepEqual(view.waiting.map((w: { node_id: string }) => w.node_id), ["editor_review"]);
  // checkEditorReturns loads the Drive folder from this artifact, so an empty
  // or wrong id here is as bad as no entry at all.
  assert.equal(view.waiting[0].artifact_id, "sha256:handoff");
});

test("a gate whose inputs have not finished is not reported as waiting", async () => {
  // Only render is done: editor_delivery is genuinely next, editor_review is not.
  const view = await reloadWith([["intent", "sha256:intent"], ["render", "sha256:render"]]);

  assert.deepEqual(view.waiting.map((w: { node_id: string }) => w.node_id), ["editor_delivery"]);
});
