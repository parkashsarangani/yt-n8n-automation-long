import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The compatibility contract is duplicated so each build context can import it
// without reaching across package roots: the engine compiler, the Remotion
// renderer bundle, and the checked-in canonical copy. Nothing in the build
// enforces that they agree, so a rule added to one and not the others would
// let the compiler accept a combination the renderer refuses to draw -- the
// exact drift the "centralize the contract" work was meant to remove.
const copies = {
  canonical: "../../contracts/motion-compatibility.json",
  engine: "../src/motion-compatibility.json",
  renderer: "../../long-compose/remotion/src/motion-compatibility.json",
} as const;

test("every copy of the motion compatibility contract is identical", () => {
  const parsed = Object.entries(copies).map(([name, relative]) => ({
    name,
    value: JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<string, string[]>,
  }));

  const [reference, ...rest] = parsed;
  for (const copy of rest) {
    assert.deepEqual(
      copy.value,
      reference!.value,
      `the ${copy.name} copy of motion-compatibility.json has drifted from the ${reference!.name} copy`,
    );
  }
});
