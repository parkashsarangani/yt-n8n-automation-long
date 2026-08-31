const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Same reasoning as label-lines.test.js: extract and eval the real function
// source rather than import the .tsx file directly (this project's tests
// don't run under a TS/JSX loader), so this exercises the actual arithmetic
// instead of only grepping for the string shape.
const source = fs.readFileSync(
  path.join(__dirname, "../remotion/src/compositions/ExplanationScene.tsx"),
  "utf8",
);
const exported = source.match(/export function mechanismChainAppearAt\(resolve\s*:\s*number\s*,\s*i\s*:\s*number\s*\)(?:\s*:\s*number)?\s*\{[^}]+\}/);
assert.ok(exported, "expected to find the mechanismChainAppearAt export");
const body = exported[0]
  .replace(/export function mechanismChainAppearAt\(resolve\s*:\s*number\s*,\s*i\s*:\s*number\s*\)(?:\s*:\s*number)?/, "function mechanismChainAppearAt(resolve, i)");
// eslint-disable-next-line no-new-func
const mechanismChainAppearAt = new Function(`${body}; return mechanismChainAppearAt;`)();

test("every icon in a 3-entity chain reaches full opacity by resolve=1, not a fraction of it", () => {
  // The exact production bug: the original formula left the 3rd of 3 icons
  // at 20% opacity even at full resolve. Confirmed on a live Remotion render
  // before this fix; this pins the arithmetic so it can't silently regress.
  for (let i = 0; i < 3; i++) {
    assert.equal(mechanismChainAppearAt(1, i), 1, `entity index ${i} must be fully opaque once the payoff has fully resolved`);
  }
});

test("later entities start appearing later, not all at once", () => {
  assert.equal(mechanismChainAppearAt(0, 0), 0);
  assert.equal(mechanismChainAppearAt(0, 1), 0);
  assert.equal(mechanismChainAppearAt(0, 2), 0);
  assert.ok(mechanismChainAppearAt(0.5, 0) > mechanismChainAppearAt(0.5, 1), "the first entity should be further along than the second at the same resolve");
  assert.ok(mechanismChainAppearAt(0.5, 1) > mechanismChainAppearAt(0.5, 2), "the second entity should be further along than the third at the same resolve");
});

test("opacity is always clamped to [0, 1], never negative or over-driven", () => {
  for (const resolve of [-0.5, 0, 0.3, 0.7, 1, 1.5]) {
    for (let i = 0; i < 4; i++) {
      const value = mechanismChainAppearAt(resolve, i);
      assert.ok(value >= 0 && value <= 1, `resolve=${resolve}, i=${i} produced out-of-range ${value}`);
    }
  }
});
