import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = JSON.parse(readFileSync(new URL("../agents/explanation_visual_planner.json", import.meta.url), "utf8"));
const legacySchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.0.0.json", import.meta.url), "utf8"));
const semanticSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.1.0.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.2.0.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");
const legacyScene = legacySchema.json_schema.properties.scenes.items;
const scene = schema.json_schema.properties.scenes.items;
const props = scene.properties;

test("explanation planner v3 emits required motion-design explanation_plan 1.2", () => {
  assert.equal(agent.version, "3");
  assert.equal(agent.produces, "explanation_plan");
  assert.equal(agent.produces_version, "1.2.0");
  assert.equal(agent.prompt, "explanation_visual_planner@1");
  assert.equal(schema.status, "active");
  assert.equal(legacySchema.status, "deprecated");
  assert.equal(semanticSchema.status, "deprecated");
  assert.ok(scene.required.includes("visual_operation"));
  assert.ok(scene.required.includes("visual_primitive"));
  assert.ok(scene.required.includes("visual_state"));
  assert.ok(scene.required.includes("composition_mode"));
  assert.equal(legacyScene.required.includes("visual_primitive"), false);
  assert.deepEqual(agent.consumes.map((input: { as: string }) => input.as), ["script", "cast_roster"]);
});

test("explanation plan encodes frame ownership and meaningful change", () => {
  assert.deepEqual(props.template_category.enum, ["explanation"]);
  assert.ok(props.scene_role.enum.includes("diagram-build"));
  assert.ok(props.scene_role.enum.includes("object-state-change"));
  assert.ok(props.character_cut_in.enum.includes("none"));
  for (const primitive of ["particles", "rays", "network", "hierarchy", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context", "cycle", "cause-chain", "before-after", "map", "timeline", "quantity", "spectrum", "physical-transformation"]) {
    assert.ok(props.visual_primitive.enum.includes(primitive), primitive);
  }
  assert.deepEqual(props.visual_state.enum, ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"]);
  assert.deepEqual(props.composition_mode.enum, ["bookend", "full-model", "reaction"]);
  assert.match(prompt, /60-80%/);
  assert.match(prompt, /at most 35%/);
  assert.match(prompt, /sound muted/);
  assert.match(prompt, /visual sentence/i);
  assert.match(prompt, /RELATIONSHIP primitives/);
  assert.match(prompt, /maximum of 3 visible labels/i);
});
