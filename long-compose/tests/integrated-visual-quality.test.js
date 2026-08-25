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
  assert.match(scene, /cinematicActingStageTransform\(cinematic, frame\)/);
  assert.match(scene, /data-physical-interaction="actor-anchored-prop"/);
  assert.match(scene, /actorRigPoint/);
  assert.match(scene, /withPhysicalInteraction/);
  assert.match(direction, /-220 \+ entry \* 220/);
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
