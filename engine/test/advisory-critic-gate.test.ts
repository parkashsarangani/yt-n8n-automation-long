import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";

// Operator decision 2026-09-27: the watchability critic is advisory for a
// human-authored (custom-episode) script. Its "abandon this topic" verdict
// parks creative_viability, which an editor's own script can never satisfy by
// switching topic -- so unattended driving approves it and carries on. A
// generated script's park is unchanged: it still needs an operator.

function makeService(manual: boolean) {
  const decisions: Array<{ node: string; result: string }> = [];
  const state = { finished: true, error: null as string | null, graph: "graph" };
  let view: { status: string; failures: unknown[]; waiting: Array<{ node_id: string }> } = {
    status: "waiting",
    failures: [],
    waiting: [{ node_id: "creative_viability" }],
  };
  const service = Object.create(VidGenService.prototype);
  service.runs = new Map([["run-test", state]]);
  service.getRun = () => view;
  service.isManualScriptRun = async () => manual;
  service.decide = async (_runId: string, node: string, decision: { result: string }) => {
    decisions.push({ node, result: decision.result });
    // The resumed run finishes at the editor handoff.
    view = { status: "waiting", failures: [], waiting: [{ node_id: "editor_review" }] };
    state.finished = true;
  };
  return { service, decisions };
}

test("a custom episode the critic says to abandon is approved past creative_viability and reaches the editor", async () => {
  const { service, decisions } = makeService(true);
  await service.driveUnattended("run-test");
  assert.deepEqual(decisions, [{ node: "creative_viability", result: "approve" }]);
});

test("a generated script parked at creative_viability still waits for an operator", async () => {
  const { service, decisions } = makeService(false);
  await service.driveUnattended("run-test");
  assert.deepEqual(decisions, [], "only human-authored scripts get the advisory treatment");
});
