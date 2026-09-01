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
  //
  // BookendComposition's own margin (580, narrower panel than reaction's)
  // is intentionally different from ReactionComposition's "both" case
  // (610, unchanged) -- see the comment on BookendComposition itself for
  // why: engine/src/workers/hybrid-visual-assets.ts used to "fix" a
  // cramped-diagram complaint by promoting bookend scenes to full-model,
  // which silently stripped characters from every episode's opening and
  // closing scene. That mechanism was removed; this narrower (but still
  // real) panel plus a smaller character scale is the actual fix, verified
  // by a live render showing both characters clearly and the diagram with
  // meaningfully more room than the pre-fix 610 margin.
  assert.match(explanationSource, /function BookendComposition[\s\S]*?<ContentStage right=\{580\}[\s\S]*?width=\{500\}\s+scale=\{1\.05\}/);
  assert.match(explanationSource, /function ReactionComposition[\s\S]*?right=\{(?:panelMode|m)\s*===\s*"both"\s*\?\s*610\s*:\s*380\}/);
});
