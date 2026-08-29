import assert from "node:assert/strict";
import test from "node:test";

import { repairOverlongLabels } from "../src/motion-contract.ts";

test("an overlong state_before/state_after/key_text is clamped at a word boundary with an ellipsis", () => {
  // The exact production symptom this repair exists for: run_ad5bd430's
  // planner wrote full clauses for state_before/state_after
  // ("Whole onion sits beside Buddy; ..."), which the 1.4.0 schema now
  // rejects outright at 32 chars -- rather than burn a full retry attempt on
  // an otherwise-good plan, clamp it here the same way the renderer's own
  // labelLines() degrades an overflow.
  const { data, repairs } = repairOverlongLabels({
    scenes: [
      {
        scene_index: 4,
        state_before: "Whole onion sits beside Buddy waiting",
        state_after: "Smell path breaks and eyes react fast",
        key_text: "A phrase that runs meaningfully past the forty-eight character budget",
      },
    ],
  });

  assert.equal(repairs.length, 3);
  const scene = (data as { scenes: Array<Record<string, string>> }).scenes[0]!;
  for (const field of ["state_before", "state_after", "key_text"] as const) {
    assert.ok(scene[field]!.length <= (field === "key_text" ? 48 : 32), `${field} must fit its schema limit`);
    assert.ok(scene[field]!.endsWith("…"), `${field} must be marked as truncated, not silently cut`);
    assert.ok(!scene[field]!.includes("  "), `${field} must not leave a trailing partial word before the ellipsis`);
  }
});

test("fields already within limit are left untouched", () => {
  const { data, repairs } = repairOverlongLabels({
    scenes: [{ scene_index: 0, state_before: "sealed cells", state_after: "ruptured cells", key_text: "chemistry, not sadness" }],
  });
  assert.equal(repairs.length, 0);
  assert.deepEqual(data, { scenes: [{ scene_index: 0, state_before: "sealed cells", state_after: "ruptured cells", key_text: "chemistry, not sadness" }] });
});

test("the clamp cuts at the last whole word, never mid-word", () => {
  const { data } = repairOverlongLabels({
    scenes: [{ scene_index: 0, state_before: "Whole onion sits beside Buddy waiting" }],
  });
  const result = (data as { scenes: Array<{ state_before: string }> }).scenes[0]!.state_before;
  // "Whole onion sits beside Buddy waiting" clamped to 32 chars must not chop
  // a word in half (e.g. must not end "...Bud…" or "...wai…").
  const withoutEllipsis = result.replace(/…$/, "");
  assert.ok(
    ["Whole onion sits beside Buddy waiting"].some((full) => full.startsWith(withoutEllipsis.trimEnd()) && full[withoutEllipsis.trimEnd().length] === " "),
    `"${result}" must end on a real word boundary from the original text`,
  );
});

test("a scene with no overlong fields among several scenes only reports the ones that actually changed", () => {
  const { data, repairs } = repairOverlongLabels({
    scenes: [
      { scene_index: 0, state_before: "sealed cells", state_after: "ruptured cells" },
      { scene_index: 1, state_before: "this state_before phrase is deliberately much too long to fit", state_after: "fine" },
    ],
  });
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]!.path, "$.scenes[1].state_before");
  const scenes = (data as { scenes: Array<Record<string, string>> }).scenes;
  assert.equal(scenes[0]!.state_before, "sealed cells", "an untouched scene must not be reconstructed/reordered");
  assert.equal(scenes[1]!.state_after, "fine");
});

test("non-string or missing fields do not crash the repair", () => {
  const { data, repairs } = repairOverlongLabels({
    scenes: [{ scene_index: 0 }, { scene_index: 1, state_before: null }, { scene_index: 2, key_text: 42 }],
  });
  assert.equal(repairs.length, 0);
  assert.equal((data as { scenes: unknown[] }).scenes.length, 3);
});
