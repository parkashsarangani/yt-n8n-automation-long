import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SCRIPT_QUALITY_THRESHOLDS } from "../src/workers/script-quality-release.ts";

const agent = JSON.parse(readFileSync(new URL("../agents/emotional_entertainment_editor.json", import.meta.url), "utf8"));
const prompt = readFileSync(new URL("../prompts/emotional_entertainment_editor/1.md", import.meta.url), "utf8");
const criticPrompt = readFileSync(new URL("../prompts/script_quality_critic/1.md", import.meta.url), "utf8");
const reportSchema = JSON.parse(readFileSync(new URL("../schemas/script_quality_report/1.1.0.json", import.meta.url), "utf8"));

test("entertainment editor is a bounded script agent before criticism", () => {
  assert.equal(agent.kind, "agent");
  assert.equal(agent.produces, "script");
  assert.equal(agent.produces_version, "1.6.0");
  assert.deepEqual(agent.consumes.map((input: { as: string }) => input.as), ["story", "script", "cast_roster"]);
  assert.ok(agent.confidence_dimensions.includes("emotional_momentum"));
  assert.ok(agent.confidence_dimensions.includes("entertainment_value"));
  assert.ok(agent.confidence_dimensions.includes("earned_surprise"));
});

test("entertainment prompt prioritizes emotional causality without sacrificing truth", () => {
  for (const phrase of [
    "Every 3-5 turns, something must change",
    "Give both characters dignity",
    "Do not force a joke quota",
    "earned surprise",
    "Do not add melodrama",
    "Preserve every supported fact",
    "Read only the spoken lines",
  ]) assert.ok(prompt.includes(phrase), phrase);
});

test("critic and deterministic release both treat entertainment as mandatory", () => {
  const required = reportSchema.json_schema.properties.scores.required as string[];
  for (const dimension of ["emotional_momentum", "entertainment_value", "surprise_freshness"]) {
    assert.ok(required.includes(dimension), dimension);
    assert.ok(criticPrompt.includes(dimension), dimension);
    assert.ok(dimension in SCRIPT_QUALITY_THRESHOLDS, dimension);
  }
  assert.equal(SCRIPT_QUALITY_THRESHOLDS.entertainment_value, 0.75);
});
