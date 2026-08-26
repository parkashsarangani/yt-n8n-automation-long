import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agent = JSON.parse(readFileSync(new URL("../agents/cartoon_visual_planner.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/visual_plan/1.9.0.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/cartoon_visual_planner/12.md", import.meta.url), "utf8");

function enumFor(property: string): string[] {
  return schema.json_schema.properties.scenes.items.properties[property].enum;
}

test("legacy visual_plan 1.9.0 remains unchanged for non-explanation pipelines", () => {
  assert.equal(schema.status, "draft");
  assert.equal(agent.model.capability, "reasoning_high");
});

test("visual_plan 1.9.0 allows doorway continuity fields used by prompt v12", () => {
  assert.ok(enumFor("background_location").includes("hallway"));
  assert.ok(enumFor("framing").includes("doorway-transition"));
  assert.ok(enumFor("framing").includes("reaction-closeup"));
  assert.ok(enumFor("framing").includes("over-shoulder"));
  assert.ok(enumFor("framing").includes("payoff-hold"));
  assert.ok(enumFor("camera_motion").includes("doorway-track"));
  assert.ok(enumFor("ambient_motion").includes("doorway-cross"));
  assert.ok(enumFor("prop_motion").includes("settle"));
});

test("prompt v12 gives an explicit passing doorway recipe", () => {
  for (const phrase of [
    "room A scene -> crossing scene -> different room B scene",
    "background_location=\"hallway\"",
    "framing=\"doorway-transition\"",
    "camera_motion=\"doorway-track\"",
    "primary_prop=\"door\"",
    "The door is a transition beat",
  ]) {
    assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
