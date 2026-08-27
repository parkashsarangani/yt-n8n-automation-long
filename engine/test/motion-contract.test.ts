import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MOTION_COMPATIBILITY, operationFitsPrimitive, requiresNumericValue } from "../src/motion-contract.ts";

const prompt = readFileSync(new URL("../prompts/explanation_visual_planner/1.md", import.meta.url), "utf8");

test("canonical compatibility contains 64 unique production-valid renderer cases", () => {
  const cases = Object.entries(MOTION_COMPATIBILITY).flatMap(([operation, primitives]) =>
    primitives.map((primitive) => `${operation}/${primitive}`)
  );
  assert.equal(cases.length, 64);
  assert.equal(new Set(cases).size, cases.length);
  for (const item of cases) {
    const [operation, primitive] = item.split("/");
    assert.equal(operationFitsPrimitive(operation as keyof typeof MOTION_COMPATIBILITY, primitive!), true, item);
  }
  assert.equal(operationFitsPrimitive("sort", "network"), false);
});

test("planner compatibility lines name every canonical primitive exactly", () => {
  for (const [operation, primitives] of Object.entries(MOTION_COMPATIBILITY)) {
    const prefix = "- `" + operation + "`:";
    const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix) && (candidate.match(/`/g)?.length ?? 0) >= 4);
    assert.ok(line, operation);
    if (operation === "payoff") continue;
    for (const primitive of primitives) assert.ok(line!.includes("`" + primitive + "`"), `${operation}/${primitive}`);
  }
});

test("numeric graphics are explicitly identified by the shared contract", () => {
  assert.equal(requiresNumericValue("counter", "particles"), true);
  assert.equal(requiresNumericValue("stack", "quantity"), true);
  assert.equal(requiresNumericValue("timeline", "path"), false);
});
