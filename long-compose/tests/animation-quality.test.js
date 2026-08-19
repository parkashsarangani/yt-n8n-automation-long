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
  assert.match(characterSource, /Easing\.out\(Easing\.cubic\)/);
  assert.match(characterSource, /ArmLayer/);
});

test("conversation direction respects semantic gaze before auto eye contact", () => {
  assert.match(sceneSource, /character\.gazeTarget !== undefined/);
  assert.match(sceneSource, /character\.gazeTarget !== "auto"/);
  assert.match(sceneSource, /actorId: character\.actorId/);
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
