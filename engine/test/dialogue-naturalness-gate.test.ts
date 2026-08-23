import test from "node:test";
import assert from "node:assert/strict";

import { agentSemanticValidationErrors } from "../src/agent-validators.ts";
import type { AgentDef } from "../src/runner.ts";

const DEF = {
  name: "dialogue_script_writer",
  kind: "agent",
  version: "8",
  consumes: [],
  produces: "script",
  prompt: "dialogue_script_writer@8",
  model: { capability: "reasoning_high" },
} as unknown as AgentDef;

function scene(scene_index: number, narration: string, point = "action=Host reacts; prop=charger; function=beat; value=viewer sees the concrete moment") {
  return { scene_index, act_index: 0, speaker: "host", emotion: "neutral", narration, point };
}

function errorsFor(lines: string[]): string[] {
  return agentSemanticValidationErrors(
    DEF,
    { scenes: lines.map((line, index) => scene(index, line)) },
    {},
  );
}

test("dialogue writer rejects repeated incantation lines", () => {
  const errors = errorsFor([
    "Phone charger. Phone charger. Phone charger.",
    "You said that four times now.",
    "Wait. Why am I in here?",
    "The charger stayed behind.",
  ]);

  assert.match(errors.join("\n"), /repeats "phone charger" three times/);
});

test("dialogue writer rejects textbook and unresolved filler phrasing", () => {
  const errors = errorsFor([
    "Wait. Why am I in here?",
    "By that, it's called the location updating effect.",
    "Okay so what do I actually do about...",
    "Say the cue while crossing.",
  ]);

  assert.match(errors.join("\n"), /definition\/explainer phrasing/);
  assert.match(errors.join("\n"), /unresolved ellipsis/);
});

test("dialogue writer does not reject natural by-that questions", () => {
  const errors = errorsFor([
    "Wait. Why am I in here?",
    "What do you mean by that?",
    "The room changed.",
    "And my cue vanished.",
    "That's annoying.",
    "Say it while you cross.",
  ]);

  assert.deepEqual(errors, []);
});

test("dialogue writer accepts short situational doorway dialogue", () => {
  const errors = errorsFor([
    "Charger. I came in for the charger.",
    "You rehearsed that like a spell.",
    "It still vanished.",
    "The room changed. The cue didn't.",
    "So the doorway robbed me?",
    "Say it while you cross.",
    "Charger. Through the door. Charger.",
    "There it is.",
  ]);

  assert.deepEqual(errors, []);
});
