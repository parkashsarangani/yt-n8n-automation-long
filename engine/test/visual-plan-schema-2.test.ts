import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = JSON.parse(readFileSync(new URL("../agents/explanation_visual_planner.json", import.meta.url), "utf8"));
const legacySchema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.0.0.json", import.meta.url), "utf8"));
const prior12 = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.2.0.json", import.meta.url), "utf8"));
const prior13 = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.3.0.json", import.meta.url), "utf8"));
const prior14 = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.4.0.json", import.meta.url), "utf8"));
const prior15 = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.5.0.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/explanation_plan/1.6.0.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");
const scene = schema.json_schema.properties.scenes.items;
const props = scene.properties;

test("explanation planner v6 emits semantic explanation_plan 1.6", () => {
  // The agent now produces 1.7.0 (adds composition_mode "character-room"),
  // but 1.6.0 -- what this test otherwise exercises -- must remain resumable
  // exactly as before: nothing in this file's assertions changed shape.
  assert.equal(agent.version, "8");
  assert.equal(agent.produces, "explanation_plan");
  assert.equal(agent.produces_version, "1.7.0");
  assert.equal(agent.prompt, "explanation_visual_planner@1");
  assert.equal(schema.status, "active");

  // Never retire resumable versions merely because a stronger representation
  // contract landed. A paused episode must still validate against the exact
  // schema that produced it.
  for (const old of [legacySchema, prior12, prior13, prior14, prior15]) {
    assert.notEqual(old.status, "retired");
  }
  assert.equal(prior12.json_schema.properties.scenes.items.properties.explanation_title.maxLength, 80);
  assert.equal(prior13.json_schema.properties.scenes.items.properties.state_before.maxLength, 64);
  assert.equal(prior14.json_schema.properties.scenes.items.properties.state_before.maxLength, 32);
  assert.equal(prior15.json_schema.properties.scenes.items.properties.state_before.maxLength, 32);

  assert.equal(props.state_before.maxLength, 32);
  assert.equal(props.state_after.maxLength, 32);
  assert.equal(props.key_text.maxLength, 48);
  assert.ok(scene.required.includes("visual_operation"));
  assert.ok(scene.required.includes("visual_primitive"));
  assert.ok(scene.required.includes("model_relations"));

  // Semantic fields are conditionally required rather than globally required:
  // the agent always emits them, but a resumed pre-1.6 payload is still legal
  // and semantic_visual_assets deterministically converts it to animated text.
  assert.equal(scene.required.includes("representation_mode"), false);
  const semanticRule = scene.allOf.find((rule: { then?: { required?: string[] } }) =>
    rule.then?.required?.includes("representation_mode"));
  assert.ok(semanticRule, "semantic fields have a conditional required rule");
  for (const field of ["representation_mode", "scene_blueprint", "visual_claim", "visual_actions"]) {
    assert.ok(semanticRule.then.required.includes(field), field);
  }

  assert.deepEqual(props.representation_mode.enum, ["concrete-scene", "domain-model", "quantitative", "spatial", "temporal", "kinetic-text"]);
  for (const blueprint of ["container-object", "molecular-system", "lattice", "particle-system", "flow-system", "cross-section", "mass-volume-comparison", "scale-comparison", "before-after-object", "map", "timeline", "animated-statement"]) {
    assert.ok(props.scene_blueprint.enum.includes(blueprint), blueprint);
  }
  assert.equal(props.visual_claim.maxLength, 180);
  assert.equal(props.visual_actions.maxItems, 6);
  assert.ok(props.visual_actions.items.properties.action.enum.includes("rearrange"));
  assert.ok(props.visual_actions.items.properties.action.enum.includes("bond"));
  assert.ok(props.visual_actions.items.required.includes("anchor_phrase"));
  assert.equal(props.entity_refs.items.pattern, "^[a-z][a-z0-9-]{0,63}$");

  const kineticRule = scene.allOf.find((rule: { if?: { properties?: { representation_mode?: { const?: string } } } }) =>
    rule.if?.properties?.representation_mode?.const === "kinetic-text");
  assert.equal(kineticRule?.then?.properties?.scene_blueprint?.const, "animated-statement");
  assert.equal(kineticRule?.then?.properties?.visual_actions?.maxItems, 0);

  const numericRule = scene.allOf.find((rule: { then?: { required?: string[] } }) => rule.then?.required?.includes("numeric_value"));
  assert.equal(numericRule?.then?.properties?.numeric_value?.type, "number");
  assert.deepEqual(agent.consumes.map((input: { as: string }) => input.as), ["script", "visual_model", "cast_roster"]);
});

test("planner explicitly prefers semantic depiction and animated text over fake diagrams", () => {
  assert.match(prompt, /show the thing or mechanism before abstracting/i);
  assert.match(prompt, /generic node\/box\/arrow diagram is not an acceptable fallback/i);
  assert.match(prompt, /animated-statement/i);
  assert.match(prompt, /anchor_phrase/i);
  assert.match(prompt, /could this same visual work for an unrelated topic/i);
  assert.match(prompt, /at least half of explanatory scenes should reuse/i);
  assert.match(prompt, /animate the mechanism/i);
  assert.match(prompt, /never distort `representation_mode` or `scene_blueprint`/i);
});
