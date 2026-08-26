import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = JSON.parse(readFileSync(new URL("../agents/explanation_visual_planner.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.0.0.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");
const props = schema.json_schema.properties.scenes.items.properties;

test("explanation planner v1 emits isolated explanation_plan 1.0", () => {
  assert.equal(agent.version, "1");
  assert.equal(agent.produces, "explanation_plan");
  assert.equal(agent.produces_version, "1.0.0");
  assert.equal(agent.prompt, "explanation_visual_planner@1");
  assert.equal(schema.status, "active");
  assert.deepEqual(agent.consumes.map((input: { as: string }) => input.as), ["script", "cast_roster"]);
});

test("explanation plan encodes frame ownership and meaningful change", () => {
  assert.deepEqual(props.template_category.enum, ["explanation"]);
  assert.ok(props.scene_role.enum.includes("diagram-build"));
  assert.ok(props.scene_role.enum.includes("object-state-change"));
  assert.ok(props.character_cut_in.enum.includes("none"));
  assert.match(prompt, /60-80%/);
  assert.match(prompt, /at most 35%/);
  assert.match(prompt, /sound muted/);
});
