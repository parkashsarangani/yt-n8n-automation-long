import assert from "node:assert/strict";
import test from "node:test";

import { repairEnumValues } from "../src/schema-repair.ts";

const VISUAL_STATES = ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"] as const;
const schema = { properties: { visual_state: { enum: [...VISUAL_STATES] } } };

test("an unrecoverable visual_state never lands on hypothesis", () => {
  // Real production plan (run_39850b3e): the planner reached for the script's
  // beat vocabulary and emitted visual_state "correction" and "implication".
  // Neither matches the renderer's enum, and because that enum happens to
  // begin with "hypothesis", the repair snapped both to it -- so the beats
  // where the explanation actually lands were drawn as tentative dashed
  // guesses. The repair reported success, so nothing surfaced it.
  for (const beat of ["correction", "implication", "takeaway", "objection-resolved"]) {
    const { data, repairs } = repairEnumValues(schema, { visual_state: beat });
    const repaired = (data as { visual_state: string }).visual_state;

    assert.ok(VISUAL_STATES.includes(repaired as typeof VISUAL_STATES[number]), `${beat} repaired to an invalid state: ${repaired}`);
    assert.notEqual(repaired, "hypothesis", `"${beat}" fell back to hypothesis, which draws it as an unasserted guess`);
    assert.equal(repaired, "mechanism", `"${beat}" should fall back to the neutral explanatory state`);
    assert.equal(repairs.length, 1);
  }
});

test("a recoverable near-miss still snaps to the value the planner meant", () => {
  for (const [written, expected] of [["Mechanism", "mechanism"], ["  PAYOFF  ", "payoff"], ["contradiction", "contradiction"]]) {
    const { data } = repairEnumValues(schema, { visual_state: written });
    assert.equal((data as { visual_state: string }).visual_state, expected);
  }
});

test("an empty string on an OPTIONAL enum field is omitted, not guessed", () => {
  // Real production run 31fb1add: episode_director emitted hero_role: "" on
  // every shot, including "normal" (non-hero) ones, because the model fills
  // every declared optional property rather than leaving it absent. Since
  // "hook" happened to be allowed[0], the old fallback-guess behavior
  // silently stamped hero_role: "hook" onto normal shots -- which then
  // fails illustrated-scene-assets.ts's own invariant ("normal shot must not
  // carry hero_role"), burning all 5 unattended retries on an identical,
  // fully deterministic failure before assets ever ran once.
  const shotSchema = {
    properties: {
      importance: { enum: ["normal", "hero"] },
      hero_role: { enum: ["hook", "first-escalation", "low-point", "turn", "payoff"] },
    },
    required: ["importance"],
  };
  const { data, repairs } = repairEnumValues(shotSchema, { importance: "normal", hero_role: "" });
  assert.ok(!("hero_role" in (data as object)), "an empty optional enum field must be dropped, never defaulted");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]!.to, "<omitted: optional, empty>");
});

test("an empty string on a REQUIRED enum field still falls back rather than leaving the payload invalid", () => {
  const shotSchema = {
    properties: { visual_state: { enum: [...VISUAL_STATES] } },
    required: ["visual_state"],
  };
  const { data } = repairEnumValues(shotSchema, { visual_state: "" });
  assert.equal((data as { visual_state: string }).visual_state, "mechanism");
});
