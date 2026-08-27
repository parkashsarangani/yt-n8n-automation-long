import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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

test("the planner prompt maps script beats onto renderer states", () => {
  // The fallback above is a safety net. The prompt is what stops the planner
  // emitting beat names in this field at all, so the mapping has to be stated.
  const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");
  for (const beat of ["correction", "implication", "objection", "recap"]) {
    assert.match(prompt, new RegExp(beat, "i"), `prompt does not tell the planner where "${beat}" belongs`);
  }
  assert.match(prompt, /NOT the script's beat names/i);
});
