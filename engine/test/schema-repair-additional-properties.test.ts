import test from "node:test";
import assert from "node:assert/strict";

import { repairAdditionalProperties, repairEnumValues } from "../src/schema-repair.ts";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["beats"],
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "asset_brief"],
        properties: {
          id: { type: "string" },
          hero_role: { type: "string", enum: ["hook", "payoff"] },
          asset_brief: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

test("drops syntax fragments, moves enclosing properties, and drops unknowns without losing values", () => {
  const input = {
    beats: [{
      id: "beat_001",
      asset_brief: {
        query: "commuter phone",
        '":{': "fragment",
        hero_role: "payoff",
        totally_unknown: "noise",
      },
    }],
  };

  const repaired = repairAdditionalProperties(schema, input);
  const beat = (repaired.data as typeof input & { beats: Array<Record<string, unknown>> }).beats[0]!;
  assert.equal(beat.hero_role, "payoff");
  assert.deepEqual(beat.asset_brief, { query: "commuter phone" });
  assert.ok(repaired.repairs.some((r) => r.action === "drop_syntax_fragment"));
  assert.ok(repaired.repairs.some((r) => r.action === "move_to_enclosing_object" && r.target === "$.beats[0].hero_role"));
  assert.ok(repaired.repairs.some((r) => r.action === "drop_unknown"));
});

test("the existing runner-facing enum repair performs structural repair first", () => {
  const input = {
    beats: [{
      id: "beat_001",
      asset_brief: { query: "commuter phone", hero_role: "PAYOFF" },
    }],
  };
  const repaired = repairEnumValues(schema, input);
  const beat = (repaired.data as { beats: Array<Record<string, unknown>> }).beats[0]!;
  assert.equal(beat.hero_role, "payoff", "misplaced value is moved then enum-normalized at its legal schema location");
});
