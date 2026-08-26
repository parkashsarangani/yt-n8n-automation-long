import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const graph = JSON.parse(readFileSync(new URL("../graphs/cartoon.json", import.meta.url), "utf8"));
const agent = JSON.parse(readFileSync(new URL("../agents/comprehension_editor.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/comprehension_editor/1.md", import.meta.url), "utf8");
const validators = readFileSync(new URL("../src/agent-validators.ts", import.meta.url), "utf8");

test("cartoon graph reviews comprehension before expensive production work", () => {
  const byId = new Map<string, { id: string; in?: string[]; policy?: { auto_pass_if?: string } }>(
    graph.nodes.map((node: { id: string; in?: string[]; policy?: { auto_pass_if?: string } }) => [node.id, node]),
  );
  assert.equal(graph.version, "6");
  assert.deepEqual(byId.get("draft_script")?.in, ["approve_story", "cast_roster"]);
  assert.deepEqual(byId.get("comprehension_edit")?.in, ["approve_story", "draft_script", "cast_roster"]);
  assert.deepEqual(byId.get("retention_edit")?.in, ["approve_story", "comprehension_edit", "cast_roster"]);
  assert.deepEqual(byId.get("quality_release")?.in, ["quality_revision", "quality_final"]);
  assert.deepEqual(byId.get("approve_script")?.in, ["quality_release"]);
  assert.equal(byId.get("approve_script")?.policy?.auto_pass_if, "always");
  for (const id of ["creative_direction", "visual_plan", "voice", "seo", "thumbnail_brief"]) {
    assert.ok(byId.get(id)?.in?.includes("approve_script"), id);
  }
});

test("comprehension editor is an agent that returns a corrected script", () => {
  assert.equal(agent.kind, "agent");
  assert.equal(agent.produces, "script");
  assert.equal(agent.prompt, "comprehension_editor@1");
  assert.deepEqual(agent.consumes.map((input: { as: string }) => input.as), ["story", "script", "cast_roster"]);
  assert.deepEqual(agent.confidence_dimensions, [
    "factual_fidelity",
    "misconception_fairness",
    "causal_clarity",
    "visual_model_explanatory_power",
    "dialogue_naturalness",
    "teach_back_success",
  ]);
});

test("comprehension editor enforces a reconstructable visual model and teach-back", () => {
  for (const phrase of [
    "why the intuitive answer looked reasonable",
    "reproduce the central visual model step by step",
    "Show its starting state",
    "Change exactly one relevant thing",
    "Make a character predict the result",
    "Build the correction directly from that mismatch",
    "genuine teach-back",
    "Never add a statistic",
  ]) {
    assert.ok(prompt.includes(phrase), phrase);
  }
});

test("edited scripts retain the existing dialogue semantic retry gates", () => {
  for (const name of ["dialogue_script_writer", "comprehension_editor", "retention_character_editor", "script_quality_reviser"]) assert.match(validators, new RegExp(name));
  assert.match(validators, /return validateDialogueScript\(payload, def\)/);
});
