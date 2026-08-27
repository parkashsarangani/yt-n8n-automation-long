const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = fs.readFileSync(path.join(__dirname, "../remotion/src/Root.tsx"), "utf8");
const compose = fs.readFileSync(path.join(__dirname, "../compose.js"), "utf8");
const scene = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/ExplanationScene.tsx"), "utf8");

test("visual operation is wired from compose bridge to Remotion", () => {
  assert.match(compose, /explanation:\s*\{/);
  assert.match(compose, /compositionId: "ExplanationScene"/);
  assert.match(compose, /visualOperation: d\.visualOperation/);
  assert.match(root, /id="ExplanationScene"/);
  assert.match(root, /visualOperation: "timeline"/);
  assert.match(compose, /templateName === "explanation"/);
});

test("renderer implements every concrete operation", () => {
  for (const operation of ["stack", "timeline", "counter", "compress", "group", "sort", "scale-compare", "payoff"]) {
    assert.match(scene, new RegExp(`"${operation}"`));
  }
  assert.match(scene, /durationInFrames/);
  assert.match(scene, /Easing\.inOut/);
  assert.match(scene, /OperationCanvas operation=\{visualOperation\}/);
});

test("reaction characters use deliberate bust panels", () => {
  assert.match(scene, /function BustReactionPanel/);
  assert.match(scene, /scale=\{0\.82\}/);
  assert.match(scene, /borderRadius: 38/);
  assert.doesNotMatch(scene, /scale=\{0\.58\}/);
  assert.doesNotMatch(scene, /function CharacterRail/);
});

test("production metadata is never rendered as a viewer-facing label", () => {
  assert.doesNotMatch(scene, /role\.replaceAll/);
  assert.doesNotMatch(scene, /textTransform: "uppercase"/);
});

test("captions are larger, raised, shorter, and omit speaker prefixes", () => {
  assert.match(compose, /Style: Caption,Inter Bold,76/);
  assert.match(compose, /,90,90,172,1/);
  assert.match(compose, /const WORDS_PER_PHRASE = 6/);
  assert.doesNotMatch(compose, /speakerName\.toUpperCase/);
});

test("sound design follows operations and preserves a restrained payoff", () => {
  assert.match(compose, /operationFallback/);
  assert.match(compose, /sfxEvents\.length >= 7/);
  assert.match(compose, /time - lastCueTime < 2\.4/);
  assert.match(compose, /explanationMode \? 0\.11 : 0\.15/);
  assert.match(compose, /volume: 0\.14/);
});
