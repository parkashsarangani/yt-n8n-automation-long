import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = JSON.parse(readFileSync(new URL("../agents/explanation_visual_planner.json", import.meta.url), "utf8"));
const legacySchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.0.0.json", import.meta.url), "utf8"));
const semanticSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.1.0.json", import.meta.url), "utf8"));
const priorSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.2.0.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.3.0.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");
const legacyScene = legacySchema.json_schema.properties.scenes.items;
const scene = schema.json_schema.properties.scenes.items;
const props = scene.properties;

test("explanation planner v3 emits required motion-design explanation_plan 1.3", () => {
  assert.equal(agent.version, "3");
  assert.equal(agent.produces, "explanation_plan");
  assert.equal(agent.produces_version, "1.3.0");
  assert.equal(agent.prompt, "explanation_visual_planner@1");
  assert.equal(schema.status, "active");
  assert.equal(legacySchema.status, "deprecated");
  assert.equal(semanticSchema.status, "deprecated");
  // 1.2.0 is deprecated, not retired: an episode paused on a stored 1.2.0
  // explanation_plan must still validate and resume against its own schema.
  // Retired versions fail even an exact-version read (see registry.ts), which
  // is exactly the resumability break the versioned-artifact contract exists
  // to prevent -- so tightening the limits had to land as a new version
  // rather than mutating 1.2.0 in place.
  assert.equal(priorSchema.status, "deprecated");
  assert.equal(priorSchema.json_schema.properties.scenes.items.properties.explanation_title.maxLength, 80);
  assert.ok(scene.required.includes("visual_operation"));
  assert.ok(scene.required.includes("visual_primitive"));
  assert.ok(scene.required.includes("visual_state"));
  assert.ok(scene.required.includes("composition_mode"));
  assert.equal(scene.required.includes("numeric_value"), false);
  const characterRule = scene.allOf.find((rule: { then?: { required?: string[] } }) => rule.then?.required?.includes("speaker_emotion"));
  assert.ok(characterRule?.then.required.includes("listener_gesture"));
  const numericRule = scene.allOf.find((rule: { then?: { required?: string[] } }) => rule.then?.required?.includes("numeric_value"));
  assert.equal(numericRule?.then.properties.numeric_value.type, "number");
  for (const discarded of ["background_location", "background_variant", "background_tone", "framing", "camera_motion", "visual_event", "ambient_motion", "speaker_emphasis", "cutaway_label"]) {
    assert.equal(scene.required.includes(discarded), false, discarded);
  }
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
  assert.match(prompt, /relationship primitives/i);
  assert.match(prompt, /no more than two visible labels/i);
  assert.match(prompt, /canonical entities/i);
  assert.match(prompt, /at least half of explanatory scenes must reuse/i);
  assert.match(prompt, /primitive defines what exists/i);
  assert.match(prompt, /Do not emit or optimize legacy background/i);
});
