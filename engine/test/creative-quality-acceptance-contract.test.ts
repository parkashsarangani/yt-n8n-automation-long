import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The engine Docker image (engine/Dockerfile) builds from the engine/
// directory only, so docs/ at the repo root is never present inside the
// container CI runs tests in. Read it opportunistically and skip the
// doc-content checks there instead of failing the whole file.
const docPath = new URL("../../docs/creative-quality-acceptance.md", import.meta.url);
const doc = existsSync(docPath) ? readFileSync(docPath, "utf8") : null;
const validator = readFileSync(new URL("../src/agent-validators.ts", import.meta.url), "utf8");
const compiler = readFileSync(new URL("../src/workers/cartoon-scenes-v14.ts", import.meta.url), "utf8");
const dialoguePrompt = readFileSync(new URL("../prompts/dialogue_script_writer/9.md", import.meta.url), "utf8");
const visualPrompt = readFileSync(new URL("../prompts/cartoon_visual_planner/11.md", import.meta.url), "utf8");
const creativePrompt = readFileSync(new URL("../prompts/cartoon_creative_director/4.md", import.meta.url), "utf8");

test("creative acceptance contract documents the actual 9.5 failure modes", { skip: doc === null }, () => {
  for (const phrase of [
    "captions muted",
    "room A, crossing, room B",
    "generic square icon card",
    "exact repeated caption line",
    "more than two consecutive scenes with the same shot recipe",
    "physical-vs-badge mode",
    "score is earned by the rendered MP4",
  ]) {
    assert.match(doc!, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("acceptance contract maps to real enforcement files", { skip: doc === null }, () => {
  for (const fileName of [
    "dialogue_script_writer/9.md",
    "cartoon_creative_director/4.md",
    "cartoon_visual_planner/11.md",
    "agent-validators.ts",
    "cartoon-scenes-v14.ts",
    "cinematicDirection.ts",
    "CartoonScene.tsx",
    "PropAsset.tsx",
  ]) {
    assert.match(doc!, new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("quality gates cover dialogue duplication and visual stasis", () => {
  for (const token of [
    "duplicateDialogueFailures",
    "nearly repeats",
    "opening phrase",
    "too static",
    "shot rhythm is too flat",
    "camera direction is too flat",
    "doorway",
  ]) {
    assert.match(validator, new RegExp(token));
  }
});

test("compiler emits cinematic metadata required by the acceptance contract", () => {
  for (const token of [
    "shotRecipe",
    "propPlacement",
    "cameraIntent",
    "continuityGroup",
    "sfxCue",
    "cinematic-9-5",
    "crossing-transition",
    "payoff-hold",
  ]) {
    assert.match(compiler, new RegExp(token));
  }
});

test("agent prompts are upgraded for authored output rather than generic rendering", () => {
  assert.match(dialoguePrompt, /no exact repeated caption lines/i);
  assert.match(dialoguePrompt, /payoff/i);
  assert.match(creativePrompt, /callback architecture/i);
  assert.match(creativePrompt, /performance notes/i);
  assert.match(visualPrompt, /shot recipe/i);
  assert.match(visualPrompt, /room A/i);
  assert.match(visualPrompt, /prop placement/i);
});
