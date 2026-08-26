const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = fs.readFileSync(path.join(__dirname, "../remotion/src/Root.tsx"), "utf8");
const compose = fs.readFileSync(path.join(__dirname, "../compose.js"), "utf8");
const scene = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/ExplanationScene.tsx"), "utf8");

test("explanation template is wired from compose bridge to Remotion", () => {
  assert.match(compose, /explanation:\s*\{/);
  assert.match(compose, /compositionId: "ExplanationScene"/);
  assert.match(root, /id="ExplanationScene"/);
  assert.match(compose, /templateName === "explanation"/);
});

test("explanation composition makes models primary and characters optional", () => {
  for (const role of ["diagram-build", "process-flow", "object-state-change", "comparison", "kinetic-emphasis", "character-reaction", "recap"]) {
    assert.match(scene, new RegExp(`"${role}"`));
  }
  assert.match(scene, /characterCutIn = "none"/);
  assert.match(scene, /<Diagram role=\{role\}/);
  assert.match(scene, /scale=\{0\.58\}/);
});
