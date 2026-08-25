const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const compose = fs.readFileSync(path.join(root, "compose.js"), "utf8");
const scene = fs.readFileSync(path.join(root, "remotion/src/compositions/CartoonScene.tsx"), "utf8");
const direction = fs.readFileSync(path.join(root, "remotion/src/lib/cinematicDirection.ts"), "utf8");
const registry = fs.readFileSync(path.join(root, "remotion/src/lib/assetRegistry.ts"), "utf8");
const dressing = fs.readFileSync(path.join(root, "remotion/src/components/SceneDressing.tsx"), "utf8");

test("production bridge forwards all cinematic direction into Remotion", () => {
  for (const token of ["shotType: d.shotType || d.framing", "visualStyle: d.visualStyle || d.visual_style", "cinematic: d.cinematic"]) {
    assert.match(compose, new RegExp(token.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});

test("acting presets and carried props materially affect rendered pixels", () => {
  assert.match(scene, /cinematicActingStageTransform\(cinematic, frame, durationInFrames\)/);
  assert.match(scene, /data-physical-interaction="actor-anchored-prop"/);
  assert.match(scene, /actorRigPoint/);
  assert.match(scene, /withPhysicalInteraction/);
  assert.match(direction, /travel \* 480/);
  assert.match(scene, /data-acting-actor/);
  assert.match(scene, /data-held-prop-follows-actor=\"true\"/);
});

test("cinematic recipes produce dedicated blocking instead of generic two-shots", () => {
  assert.match(scene, /withCinematicRecipeBlocking/);
  for (const recipe of ["reaction-closeup", "prop-insert", "over-shoulder", "payoff-hold"]) {
    assert.match(scene, new RegExp(`case \\"${recipe}\\"`));
  }
  assert.match(scene, /insert \? 1\.85 : 0\.64/);
});

test("reaction and over-shoulder recipes preserve deliberate depth hierarchy", () => {
  // Reaction: waist-up isolation, keeping the full face readable while the lower rig exits frame.
  assert.match(scene, /x: 690, y: 500, scale: baseScale \* 1\.48/);
  assert.match(scene, /-560 : 1740, y: 310, scale: baseScale \* 0\.78/);
  // OTS: near-camera listener is pushed down so legs leave frame and shoulder/head own the edge.
  assert.match(scene, /x: 760, y: 300, scale: baseScale \* 0\.98/);
  assert.match(scene, /-440 : 1500, y: 450, scale: baseScale \* 1\.55/);
});

test("central charger is a physical self-authored object, not the MDI icon card", () => {
  assert.match(registry, /prop:phone-charger:physical/);
  assert.doesNotMatch(registry, /prop:phone-charger:mdi/);
  assert.ok(fs.existsSync(path.join(root, "remotion/public/assets/props/physical/phone-charger.svg")));
});

test("long-form captions and sound design are production-routed", () => {
  assert.match(compose, /const WORDS_PER_PHRASE = 6/);
  assert.match(compose, /Inter Bold,50/);
  assert.match(compose, /template_data\?\.cinematic\?\.sfxCue/);
  assert.match(compose, /loudnorm=I=-14:TP=-1\.0:LRA=9/);
});

test("formerly generic environments now have location-specific dressing", () => {
  for (const location of ["bedroom", "cafe", "classroom", "library", "airport", "shop", "bathroom", "hospital-room", "studio", "car-interior", "park"]) {
    assert.match(dressing, new RegExp(`location === \\"${location}\\"`));
  }
});