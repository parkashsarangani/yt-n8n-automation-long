const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// labelLines runs the real behavior, not a source-string check, because the
// bug it exists to pin was invisible to every string-matching test: the
// function compiled fine, matched every `assert.match(motion, /.../)` in the
// suite, and looked correct on read. It only failed at runtime. Extracting
// the source and stripping TS type annotations lets a plain `node --test`
// run (this project's tests don't run under a TS loader) exercise the actual
// function instead of grepping for its shape.
const source = fs.readFileSync(
  path.join(__dirname, "../remotion/src/compositions/MotionDesignSystem.tsx"),
  "utf8",
);
const start = source.indexOf("export const labelLines = ");
assert.ok(start >= 0, "expected to find the labelLines export");
const end = source.indexOf("\n};", start) + "\n}".length;
const body = source
  .slice(start, end)
  .replace("export const labelLines = ", "")
  .replace(/: string\[\]/g, "")
  .replace(/: string/g, "")
  .replace(/: number/g, "")
  // Only the TS non-null-assertion `!` (both occurrences in this function
  // immediately follow `]`), never a logical-NOT `!`. A blanket `/!/g` strip
  // also ate `!words.length` and `!current`, inverting the function's
  // boolean logic and making every test below fail the same way regardless
  // of what they checked -- a reminder to actually run a test before trusting
  // that an extraction script's output means what it looks like it means.
  .replace(/\]!/g, "]");
// eslint-disable-next-line no-new-func
const labelLines = new Function(`return (${body});`)();

test("a single word is never dropped", () => {
  // The real regression: `lines[lines.length - 1] = word` when `lines` is
  // still empty is `lines[-1] = word`, which sets a non-index property and
  // leaves `.length` at 0 -- so a one-word label returned an EMPTY array and
  // Label's `if (!lines.length) return null` deleted it outright. Every
  // short label in the renderer ("before", "after", "result", "limit",
  // "resolved", a payoff's keyText) is a single word and would have vanished
  // from the finished video, not just the labels the audit's screenshots
  // happened to show missing.
  for (const word of ["before", "after", "result", "limit", "resolved", "chain"]) {
    assert.deepEqual(labelLines(word, 30), [word], `"${word}" must survive as its own line`);
  }
});

test("a two-word label keeps its first word", () => {
  // The exact production symptom: "cause chain" rendered as just "chain".
  // The first word only escaped deletion here because the second word forced
  // a real `.push()`, which is the only code path that used a valid index.
  assert.deepEqual(labelLines("cause chain", 7), ["cause", "chain"]);
});

test("a label that overflows two lines keeps its start instead of disappearing", () => {
  const lines = labelLines("cause chain evidence result limit", 7);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "cause");
  assert.ok(lines[1].endsWith("…"), "overflow must be marked, not silently cut");
  assert.ok(lines[1].startsWith("chain"), "the overflow line must still start with the next real word");
});

test("wrapping respects the given character budget instead of a fixed default", () => {
  // The default maxChars=18 used to be baked in regardless of the pill's
  // actual maxWidth, so a wide full-model pill wrapped exactly as early as a
  // narrow dense-row slot despite having far more room.
  assert.deepEqual(labelLines("wide open room", 30), ["wide open room"]);
  assert.deepEqual(labelLines("wide open room", 10), ["wide open", "room"]);
});

test("blank input produces no lines, not a crash", () => {
  assert.deepEqual(labelLines("", 20), []);
  assert.deepEqual(labelLines("   ", 20), []);
});

test("a real before/after phrase from production does not truncate at the before-after primitive's maxWidth", () => {
  // Real content from run_f7167c64 (ice-float episode, MotionDesignSystem.tsx
  // "before-after" primitive). Label's char budget is
  // `max(10, floor((maxWidth-38)/30.24))` -- the `max(10, ...)` floor meant
  // the primitive's own box width (leftWidth/rightWidth, ~280-499px) produced
  // the SAME 10-char budget as the unfixed 300 default, silently truncating
  // "Compact liquid arrangement" to "Compact liquid ar...". The primitive now
  // passes a fixed maxWidth of 500, which computes to maxChars=15 here --
  // pin that both phrases fit in 2 lines with no ellipsis.
  const maxChars = Math.max(10, Math.floor((500 - 38) / (54 * 0.56)));
  assert.equal(maxChars, 15, "maxWidth=500 must clear the 15-char threshold this phrase needs");

  const before = labelLines("Compact liquid arrangement", maxChars);
  assert.deepEqual(before, ["Compact liquid", "arrangement"]);
  assert.ok(!before.some((line) => line.includes("…")), "before phrase must not be truncated");

  const after = labelLines("Open solid arrangement", maxChars);
  assert.deepEqual(after, ["Open solid", "arrangement"]);
  assert.ok(!after.some((line) => line.includes("…")), "after phrase must not be truncated");
});
