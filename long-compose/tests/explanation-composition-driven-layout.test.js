const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const explanationSource = fs.readFileSync(
  path.join(root, "remotion", "src", "compositions", "ExplanationScene.tsx"),
  "utf8",
);

test("bookend/reaction spatial allocation is composition-driven, not scene-position-driven", () => {
  // A full-model explanation must get the wider canvas whenever the scene's
  // composition mode calls for it, not only on the opening/closing scene --
  // the engine-side half of this contract (which composition_mode routes to
  // "bookend") lives in engine/test/hybrid-audit-regressions.test.ts.
  assert.match(explanationSource, /function BookendComposition[\s\S]*?<ContentStage right=\{610\}/);
  assert.match(explanationSource, /function ReactionComposition[\s\S]*?panelMode === "both" \? 610 : 380/);
});
