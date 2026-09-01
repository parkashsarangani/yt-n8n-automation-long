import test from "node:test";
import assert from "node:assert/strict";

import { repairMissingOutroFlag } from "../src/script-repair.ts";

function sceneWith(point: string, extra: Record<string, unknown> = {}) {
  return { scene_index: 0, speaker: "buddy", emotion: "happy", narration: "line", point, ...extra };
}

test("repairs the exact real production mistake: one correctly-placed outro scene missing its flag", () => {
  // Real evidence: three separate runs this session (a 45s episode, and a
  // 30s episode twice) burned all 3 dialogue_script_writer attempts on
  // exactly this -- real outro content, correct final position, missing
  // is_outro:true.
  const payload = {
    scenes: [
      sceneWith("action=...; prop=x; function=recap confirms_understanding; value=..."),
      sceneWith("action=Buddy and Host turn toward camera; prop=x; function=outro; value=the episode closes with a genuine reason to subscribe"),
    ],
  };
  const { data, repairs } = repairMissingOutroFlag(payload);
  const scenes = (data as { scenes: Array<Record<string, unknown>> }).scenes;
  assert.equal(scenes[0]!.is_outro, undefined);
  assert.equal(scenes[1]!.is_outro, true);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0]!.path, /scenes\[1\]\.is_outro/);
});

test("does nothing when a scene is already correctly flagged", () => {
  const payload = {
    scenes: [
      sceneWith("action=...; prop=x; function=recap confirms_understanding; value=..."),
      sceneWith("action=...; prop=x; function=outro; value=...", { is_outro: true }),
    ],
  };
  const { repairs } = repairMissingOutroFlag(payload);
  assert.equal(repairs.length, 0);
});

test("does not repair when there is no outro-like scene at all", () => {
  // A genuinely missing outro is a different problem this function must
  // not paper over -- there is nothing unambiguous to fix.
  const payload = { scenes: [sceneWith("action=...; prop=x; function=recap confirms_understanding; value=...")] };
  const { repairs } = repairMissingOutroFlag(payload);
  assert.equal(repairs.length, 0);
});

test("does not repair when the outro-like scene is not the literal last scene", () => {
  const payload = {
    scenes: [
      sceneWith("action=...; prop=x; function=outro; value=..."),
      sceneWith("action=...; prop=x; function=recap confirms_understanding; value=..."),
    ],
  };
  const { data, repairs } = repairMissingOutroFlag(payload);
  assert.equal(repairs.length, 0);
  assert.deepEqual(data, payload);
});

test("does not repair when more than one scene looks like an outro", () => {
  // The split-across-two-scenes mistake -- a different real failure mode
  // (see agent-validators.ts's "outro gate" for that one). This function
  // must leave it for the semantic gate to catch with retry feedback, not
  // guess which one is real.
  const payload = {
    scenes: [
      sceneWith("action=...; prop=x; function=outro; value=..."),
      sceneWith("action=...; prop=x; function=outro; value=..."),
    ],
  };
  const { repairs } = repairMissingOutroFlag(payload);
  assert.equal(repairs.length, 0);
});

test("ignores malformed payloads instead of throwing", () => {
  assert.deepEqual(repairMissingOutroFlag(null), { data: null, repairs: [] });
  assert.deepEqual(repairMissingOutroFlag({}), { data: {}, repairs: [] });
  assert.deepEqual(repairMissingOutroFlag({ scenes: [] }), { data: { scenes: [] }, repairs: [] });
});
