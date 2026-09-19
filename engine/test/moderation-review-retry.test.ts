import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService, MAX_MODERATION_REVIEW_ATTEMPTS } from "../src/service.ts";

// Production incident 2026-09-18: a "review" (not "block") pre-TTS
// moderation verdict on a benign scene permanently wedged a run -- the same
// script text was re-checked against the same cached moderation report every
// ~16 minutes, forever, since resumeFailedRun() alone never re-runs
// moderation. driveUnattended() must instead draft fresh wording (the same
// self-heal watchability already gets), capped so it never retries forever,
// and alert an operator once it gives up.

function makeService(failureMessage: string) {
  const calls: string[] = [];
  const state = { finished: true, error: null as string | null, graph: "graph" };
  const service = Object.create(VidGenService.prototype);
  service.runs = new Map([["run-test", state]]);
  service.resolveRunGraph = () => ({ graph_id: "illustrated_story", version: "1" });
  service.graph = { graph_id: "illustrated_story", version: "1" };
  service.transformations = new Map();
  const recorded: unknown[] = [];
  service.runLog = { record: async (r: unknown) => { recorded.push(r); } };
  service.getRun = () => ({
    status: "blocked",
    failures: [{ node_id: "voice", error: failureMessage }],
  });
  service.isManualScriptRun = async () => false;
  service.executor = {
    regenerateNode: async (_graph: unknown, runId: string, nodeId: string, _reason: string) => {
      assert.equal(runId, "run-test");
      assert.equal(nodeId, "draft_script");
      calls.push("regenerateNode");
    },
  };
  service.resumeFailedRun = async () => { calls.push("resumeFailedRun"); state.finished = true; };
  return { service, calls, recorded };
}

test("a moderation-review block regenerates the script instead of retrying the same text forever", async () => {
  const { service, calls } = makeService(
    "voice blocked by pre-TTS moderation (review): scene 2: OpenAI moderation flagged review category violence",
  );

  await service.driveUnattended("run-test");

  // regenerateNode+resumeFailedRun alternate for MAX_MODERATION_REVIEW_ATTEMPTS
  // rounds, then it gives up without a further regenerate.
  const expected: string[] = [];
  for (let i = 0; i < MAX_MODERATION_REVIEW_ATTEMPTS; i++) expected.push("regenerateNode", "resumeFailedRun");
  assert.deepEqual(calls, expected);
});

test("giving up persists the terminal failure but does not itself alert anyone", async () => {
  // driveUnattended gives up once per scheduler attempt. Alerting here would
  // mail out a problem that the next attempt still fixes, so the handoff to a
  // human belongs to the scheduler's own give-up (see scheduler.test.ts).
  const { service, recorded } = makeService(
    "voice blocked by pre-TTS moderation (review): scene 2: OpenAI moderation flagged review category violence",
  );

  const originalFetch = globalThis.fetch;
  const posted: unknown[] = [];
  process.env["OPERATOR_ALERT_WEBHOOK_URL"] = "https://example.test/webhook";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await service.driveUnattended("run-test");
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPERATOR_ALERT_WEBHOOK_URL"];
  }

  assert.equal(posted.length, 0, "the inner loop must stay silent");

  assert.equal(recorded.length, 1);
  assert.equal((recorded[0] as { node_id: string }).node_id, "voice");
  assert.equal((recorded[0] as { status: string }).status, "failed");
});

test("a block (not review) moderation verdict is never treated as auto-repairable", async () => {
  const { service, calls } = makeService(
    "voice blocked by pre-TTS moderation (block): scene 1: OpenAI moderation flagged blocking category illicit",
  );
  // A "block" failure falls through to the generic auto-resume path, not the
  // moderation-review self-heal -- it must never regenerate the script.
  await service.driveUnattended("run-test");
  assert.ok(!calls.includes("regenerateNode"), "block verdicts must not trigger a script rewrite");
});
