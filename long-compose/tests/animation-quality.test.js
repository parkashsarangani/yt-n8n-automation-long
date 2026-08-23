const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const characterSource = fs.readFileSync(
  path.join(root, "remotion", "src", "components", "Character.tsx"),
  "utf8",
);
const sceneSource = fs.readFileSync(
  path.join(root, "remotion", "src", "compositions", "CartoonScene.tsx"),
  "utf8",
);
const backgroundSource = fs.readFileSync(
  path.join(root, "remotion", "src", "components", "Background.tsx"),
  "utf8",
);
const environmentSource = fs.readFileSync(
  path.join(root, "remotion", "src", "lib", "environment.ts"),
  "utf8",
);

function readRig(rig, file) {
  return fs.readFileSync(
    path.join(root, "remotion", "public", "characters", rig, file),
    "utf8",
  );
}

test("cartoon runtime exposes semantic acting controls", () => {
  for (const emotion of [
    "neutral", "happy", "amused", "skeptical", "confused", "concerned",
    "sad", "angry", "surprised", "scared", "thinking", "annoyed",
  ]) {
    assert.match(characterSource, new RegExp(`"${emotion}"`));
  }

  for (const gesture of [
    "idle", "explain", "point-left", "point-right", "shrug",
    "hands-open", "surprised", "thinking", "facepalm", "celebrate",
  ]) {
    assert.match(characterSource, new RegExp(`"${gesture}"`));
  }

  assert.match(characterSource, /actorId\?: string/);
  assert.match(characterSource, /gazeTarget\?: GazeTarget/);
  assert.match(characterSource, /motionOffsetFrames\?: number/);
  assert.match(characterSource, /const motionFrame = frame \+/);
  assert.match(characterSource, /arms\/\$\{side\}-\$\{target\}\.svg/);
  assert.doesNotMatch(characterSource, /gestureProgress|upOpacity|downOpacity/);
  assert.match(characterSource, /ArmLayer/);
});

test("panic performance is character-local and never continuous whole-frame shake", () => {
  assert.match(characterSource, /fearTremorX/);
  assert.match(characterSource, /fearTremorY/);
  assert.match(characterSource, /emotion === "scared"/);
  assert.doesNotMatch(sceneSource, /shakeX|shakeY|effect\.shake/);
  assert.doesNotMatch(environmentSource, /\bshake\s*:/);
  assert.doesNotMatch(environmentSource, /shake:\s*number/);
});

test("conversation direction respects semantic gaze before auto eye contact", () => {
  assert.match(sceneSource, /character\.gazeTarget === "auto"/);
  assert.match(sceneSource, /actorId = character\.actorId \?\? character\.animationKey/);
  // Two characters given the same explicit actorId/animationKey must not
  // silently collide into the same animation phase seed (regression test for
  // the fixed "duplicate actorId reintroduces lockstep" bug).
  assert.match(sceneSource, /seenActorIds\.has\(actorId\)/);
});

test("active speaker treatment gives every emphasis mode a distinct rendering path", () => {
  assert.match(characterSource, /emphasis\?: CharacterEmphasis/);
  assert.match(characterSource, /dimmed\?: boolean/);
  assert.match(characterSource, /activePulseScale/);
  assert.match(characterSource, /drop-shadow\(0 0 18px/);
  assert.match(characterSource, /"caption-anchor"/);
  assert.match(characterSource, /rgba\(255,221,76,0\.96\)/);

  assert.match(sceneSource, /speakerEmphasis\?: SpeakerEmphasis/);
  assert.match(sceneSource, /case "listener-dim"/);
  assert.match(sceneSource, /case "caption-anchor"/);
  assert.match(sceneSource, /speakerEmphasis === "listener-dim"/);
  assert.match(sceneSource, /useMemo/);
  assert.match(sceneSource, /withConversationDirection\(characters, speakerEmphasis\)/);
});

test("cartoon backgrounds expose deterministic ambient motion", () => {
  for (const motion of [
    "subtle-parallax", "window-light", "monitor-glow", "chart-wiggle",
    "clock-tick", "rain-window", "dust-float",
  ]) {
    assert.match(backgroundSource, new RegExp(`"${motion}"`));
  }
  assert.match(backgroundSource, /ambientOffset/);
  assert.match(backgroundSource, /AmbientOverlay/);
  assert.match(backgroundSource, /useCurrentFrame/);
  assert.match(backgroundSource, /AmbientFrameMath/);
  assert.equal((backgroundSource.match(/Math\.sin\(frame \/ 95\)/g) ?? []).length, 1);
  assert.equal((backgroundSource.match(/Math\.cos\(frame \/ 131\)/g) ?? []).length, 1);
});

test("cartoon direction dispatches are exhaustive", () => {
  assert.match(sceneSource, /assertNever\(type\)/);
  assert.match(backgroundSource, /assertNever\(ambient\)/);
});

test("cartoon visual events render deterministic overlays", () => {
  for (const event of [
    "alarm-pulse", "screen-change", "audience-silhouette", "metaphor-cutaway",
    "prop-tremble", "thought-bubble", "reaction-pop", "callback-card",
  ]) {
    assert.match(sceneSource, new RegExp(`"${event}"`));
  }
  assert.match(sceneSource, /VisualEventOverlay/);
  assert.match(sceneSource, /audience-silhouette/);
  // Non-card effects still render distinct visual treatment, not text.
  assert.match(sceneSource, /rgba\(255,70,70,0\.38\)/);
  assert.match(sceneSource, /rgba\(37,99,235,0\.50\)/);
});

test("production rigs have distinct silhouettes and coherent palettes", () => {
  const hostBody = readRig("pilot", "body.svg");
  const hostHead = readRig("pilot", "head.svg");
  const buddyBody = readRig("pilot-2", "body.svg");
  const buddyHead = readRig("pilot-2", "head.svg");

  assert.notEqual(hostBody, buddyBody);
  assert.notEqual(hostHead, buddyHead);

  assert.match(hostBody, /#147D84/);
  assert.match(hostHead, /#49B4BA/);
  assert.match(buddyBody, /#E3A62F/);
  assert.match(buddyHead, /#4A2E24/);

  assert.match(hostHead, /narrower angular host face/);
  assert.match(buddyHead, /rounder buddy face/);

  for (const file of ["left-down.svg", "left-up.svg", "right-down.svg", "right-up.svg"]) {
    assert.match(readRig("pilot", `arms/${file}`), /#DFAE8C/);
    assert.match(readRig("pilot-2", `arms/${file}`), /#C98968/);
  }
  for (const file of ["eyebrow-normal.svg", "eyebrow-angry.svg", "eyebrow-surprised.svg"]) {
    assert.match(readRig("pilot", `expressions/${file}`), /#20343D/);
    assert.match(readRig("pilot-2", `expressions/${file}`), /#4A2E24/);
  }
});
