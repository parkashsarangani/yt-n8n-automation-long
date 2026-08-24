const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const cartoonScene = readFileSync(join(root, "remotion/src/compositions/CartoonScene.tsx"), "utf8");
const propAsset = readFileSync(join(root, "remotion/src/components/PropAsset.tsx"), "utf8");
const cinematic = readFileSync(join(root, "remotion/src/lib/cinematicDirection.ts"), "utf8");

test("cartoon renderer consumes cinematic shot direction", () => {
  for (const token of [
    "CinematicSceneSpec",
    "cinematicCameraStyle",
    "cinematicTransitionStyle",
    "cinematicOverlayStyle",
    "cinematicCharacterLayerStyle",
    "data-shot-recipe",
  ]) {
    assert.match(cartoonScene, new RegExp(token));
  }
  assert.match(cartoonScene, /cinematic\?: CinematicSceneSpec/);
  assert.match(cartoonScene, /normalizedShotRecipe\(cinematic\?\.shotRecipe\)/);
});

test("cinematic direction exposes reusable shot recipes and transitions", () => {
  for (const recipe of [
    "establishing",
    "two-shot",
    "reaction-closeup",
    "prop-insert",
    "over-shoulder",
    "crossing-transition",
    "callback-reveal",
    "payoff-hold",
  ]) {
    assert.match(cinematic, new RegExp(`"${recipe}"`));
  }
  for (const transition of ["doorway-slide", "prop-match-cut", "reaction-pop-cut", "soft-push-left", "soft-push-right"]) {
    assert.match(cinematic, new RegExp(`"${transition}"`));
  }
});

test("physical prop rendering is the default; badge mode is explicit", () => {
  assert.match(propAsset, /data-prop-mode="physical"/);
  assert.match(propAsset, /data-prop-mode="badge"/);
  assert.match(propAsset, /shouldRenderPropAsBadge/);
  assert.match(cartoonScene, /propPlacementFor\(background, prop, cinematic\)/);
  assert.match(cartoonScene, /renderMode: badge \? "badge" : "physical"/);
});

test("renderer keeps exhaustive direction dispatches", () => {
  assert.match(cartoonScene, /assertNever\(type\)/);
  assert.match(cartoonScene, /assertNever\(shotType\)/);
  assert.match(cartoonScene, /assertNever\(mask\)/);
});
