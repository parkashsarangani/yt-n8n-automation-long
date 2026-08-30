import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = JSON.parse(readFileSync(new URL("../agents/explanation_visual_planner.json", import.meta.url), "utf8"));
const legacySchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.0.0.json", import.meta.url), "utf8"));
const semanticSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.1.0.json", import.meta.url), "utf8"));
const priorSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.2.0.json", import.meta.url), "utf8"));
const priorPriorSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.3.0.json", import.meta.url), "utf8"));
const labelLimitSchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.4.0.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.5.0.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");
const legacyScene = legacySchema.json_schema.properties.scenes.items;
const scene = schema.json_schema.properties.scenes.items;
const props = scene.properties;

test("explanation planner v4 emits required motion-design explanation_plan 1.5", () => {
  assert.equal(agent.version, "4");
  assert.equal(agent.produces, "explanation_plan");
  assert.equal(agent.produces_version, "1.5.0");
  assert.equal(agent.prompt, "explanation_visual_planner@1");
  assert.equal(schema.status, "active");
  assert.equal(legacySchema.status, "deprecated");
  assert.equal(semanticSchema.status, "deprecated");
  // 1.2.0/1.3.0 are deprecated, not retired: an episode paused on a stored
  // 1.2.0 or 1.3.0 explanation_plan must still validate and resume against
  // its own schema. Retired versions fail even an exact-version read (see
  // registry.ts), which is exactly the resumability break the
  // versioned-artifact contract exists to prevent -- so tightening the
  // limits had to land as a new version rather than mutating an old one in
  // place, both times.
  assert.equal(priorSchema.status, "deprecated");
  assert.equal(priorSchema.json_schema.properties.scenes.items.properties.explanation_title.maxLength, 80);
  assert.equal(priorPriorSchema.status, "deprecated");
  // run_ad5bd430 showed the before-after primitive's 2-line box truncating
  // even at a much wider renderer maxWidth, because 1.3.0 still let the
  // planner author up to 64/72 chars for fields that render in a fixed-size
  // box -- roughly double what a legible 2-line label can hold.
  assert.equal(priorPriorSchema.json_schema.properties.scenes.items.properties.state_before.maxLength, 64);
  // 1.4.0 joins them: model_relations had to land as 1.5.0 rather than being
  // added to 1.4.0 in place, for the same resumability reason.
  assert.equal(labelLimitSchema.status, "deprecated");
  assert.equal(labelLimitSchema.json_schema.properties.scenes.items.properties.state_before.maxLength, 32);
  assert.equal(props.state_before.maxLength, 32);
  assert.equal(props.state_after.maxLength, 32);
  assert.equal(props.key_text.maxLength, 48);
  assert.ok(scene.required.includes("visual_operation"));
  assert.ok(scene.required.includes("visual_primitive"));
  assert.ok(scene.required.includes("visual_state"));
  assert.ok(scene.required.includes("composition_mode"));
  // Required, not optional. A relation list the planner is free to omit is a
  // relation list it will omit, and every relationship primitive would keep
  // falling back to the fixed topology 1.5.0 exists to replace. An empty
  // array is the valid answer for a scene with nothing to connect.
  assert.ok(scene.required.includes("model_relations"));
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
  assert.match(prompt, /well under 32 characters/i);
  assert.match(prompt, /never a clause or sentence/i);
  // Diagram specificity: bias primitive selection toward the ones the
  // renderer actually gives real per-entity icons (objects/before-after/
  // cause-chain/network/timeline), as a tiebreaker only -- correctness must
  // still come first, never distorted to chase an icon.
  assert.match(prompt, /Correctness always wins first/i);
  assert.match(prompt, /prefer `objects`, `before-after`, `cause-chain`, `network`, or `timeline`/);
});
