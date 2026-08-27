const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = fs.readFileSync(path.join(__dirname, "../remotion/src/Root.tsx"), "utf8");
const compose = fs.readFileSync(path.join(__dirname, "../compose.js"), "utf8");
const scene = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/ExplanationScene.tsx"), "utf8");
const motion = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/MotionDesignSystem.tsx"), "utf8");

test("visual operation is wired from compose bridge to Remotion", () => {
  assert.match(compose, /explanation:\s*\{/);
  assert.match(compose, /compositionId: "ExplanationScene"/);
  assert.match(compose, /visualOperation: d\.visualOperation/);
  assert.match(compose, /visualPrimitive: d\.visualPrimitive/);
  assert.match(compose, /visualState: d\.visualState/);
  assert.match(compose, /numericValue: Number\.isFinite/);
  assert.match(compose, /compositionMode: d\.compositionMode/);
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

test("renderer depicts semantic subjects instead of naming generic cards", () => {
  for (const primitive of ["particles", "rays", "wave", "horizon", "spectrum", "path", "shells", "objects"]) {
    assert.match(motion, new RegExp(`"${primitive}"`));
  }
  assert.match(motion, /function Geometry/);
  assert.match(motion, /Array\.from\(\{ length: 28 \}/);
  assert.match(motion, /<polyline points=\{points\}/);
  assert.match(motion, /primitive === "horizon"/);
  assert.match(motion, /primitive === "shells"/);
  assert.match(motion, /primitive === "objects"/);
  assert.match(scene, /function PayoffResolution/);
  assert.match(scene, /visualOperation === "payoff"/);
  assert.match(scene, /durationInFrames \* 0\.62/);
  assert.match(motion, /operation === "compress"/);
  assert.match(motion, /operation === "group"/);
  assert.match(motion, /operation === "sort"/);
  assert.match(motion, /operation === "stack"/);
  assert.match(motion, /operation === "scale-compare"/);
});

test("reaction characters use deliberate bust panels", () => {
  assert.match(scene, /function BustReactionPanel/);
  assert.match(scene, /scale=\{1\.45\}/);
  assert.match(scene, /y=\{430\}/);
  assert.match(scene, /borderRadius: 38/);
  assert.doesNotMatch(scene, /scale=\{0\.58\}/);
  assert.doesNotMatch(scene, /function CharacterRail/);
  assert.match(scene, /fontSize: 56/);
  assert.match(scene, /fontSize: 34, lineHeight: 1\.05/);
  assert.match(scene, /PRIMITIVE_GLOW/);
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
  assert.match(compose, /visualStateFallback/);
  assert.match(compose, /explanationMode \? "" : comment_hook/);
  assert.match(compose, /sfxEvents\.length >= 7/);
  assert.match(compose, /time - lastCueTime < 2\.4/);
  assert.match(compose, /explanationMode \? 0\.11 : 0\.15/);
  assert.match(compose, /volume: 0\.14/);
  assert.match(compose, /operationPhase/);
  assert.match(compose, /data\.visualOperation === "payoff"/);
  assert.match(compose, /0\.74/);
});


test("motion design system implements all relationship primitives with staged change", () => {
  for (const primitive of ["network", "hierarchy", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context", "cycle", "cause-chain", "before-after", "map", "timeline", "quantity", "spectrum", "physical-transformation"]) {
    assert.match(motion, new RegExp(`"${primitive}"`));
  }
  for (const state of ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"]) {
    assert.match(motion, new RegExp(`"${state}"`));
  }
  assert.match(motion, /setup/);
  assert.match(motion, /transform/);
  assert.match(motion, /consequence/);
  assert.match(motion, /hold/);
  assert.match(motion, /strokeDasharray/);
  assert.match(motion, /state === "hypothesis"/);
  assert.match(motion, /state === "contradiction"/);
  assert.doesNotMatch(motion, /const wrong = state === "hypothesis" \|\| state === "contradiction"/);
  assert.match(motion, /fontSize="31"/);
  assert.match(scene, /MotionDesignSystem/);
});


test("geometry, operation, state, and composition are independent renderer layers", () => {
  assert.match(motion, /function Geometry/);
  assert.match(motion, /function OperationStage/);
  assert.match(motion, /function StateDecorator/);
  assert.match(motion, /<OperationStage operation=\{operation\}/);
  assert.match(scene, /function BookendComposition/);
  assert.match(scene, /function FullModelComposition/);
  assert.match(scene, /function ReactionComposition/);
  assert.match(scene, /<CompositionFrame mode=\{compositionMode\}/);
  assert.match(scene, /operation=\{visualOperation\}/);
});

test("quantity graphics use authored data instead of a fixed count", () => {
  assert.match(motion, /numericValue/);
  assert.match(motion, /Number\.isFinite\(numericValue\)/);
  assert.doesNotMatch(motion, /Math\.round\(transform\*40\)/);
});
