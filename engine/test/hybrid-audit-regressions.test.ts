import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TEMPLATE_DATA_MAX_LENGTH,
  templateDataWithinLimit,
} from "../src/workers/hybrid-visual-assets.ts";
import { FalImageProvider } from "../src/providers/fal.ts";

const hybridSource = readFileSync(new URL("../src/workers/hybrid-visual-assets.ts", import.meta.url), "utf8");
const qaSource = readFileSync(new URL("../src/workers/qa.ts", import.meta.url), "utf8");
// This file runs inside the engine's isolated Docker test image (CI builds
// and tests ./engine and ./long-compose as two separate contexts), which
// never contains long-compose/. The two checks that need to read Remotion's
// source live at contracts/motion-visual-identity.test.ts (run once on the
// raw CI checkout, where both trees exist) and
// long-compose/tests/explanation-composition-driven-layout.test.js instead.

test("closing bookend explicitly reuses opening stable entity ids", () => {
  assert.match(hybridSource, /const ids = isClosing \? openingIds : plan \? entityIdsFor\(plan\) : \[\]/);
  assert.match(hybridSource, /const openingIds = entityIdsFor\(orderedPlans\[0\]!\)/);
});

test("template normalization cannot exceed asset_manifest 1.5 template_data limit", () => {
  const originalObject = { label: "x".repeat(7850) };
  const original = JSON.stringify(originalObject);
  assert.ok(original.length < TEMPLATE_DATA_MAX_LENGTH);
  const normalized = {
    ...originalObject,
    entityIdentityKeys: Array.from({ length: 4 }, (_, i) => `entity-${"y".repeat(60)}-${i}`),
    rendererPerformance: {
      compositionMode: "full-model",
      characterCutIn: "none",
      watchabilityFullCanvas: true,
    },
  };
  assert.ok(JSON.stringify(normalized).length > TEMPLATE_DATA_MAX_LENGTH, "fixture must exercise the overflow path");
  assert.equal(templateDataWithinLimit(original, normalized), original, "overflow must retain the previously-valid deterministic payload");
});

test("Fal shot packs reject cardinality-changing input before spending a request", async () => {
  let requests = 0;
  const fakeFetch = (async () => {
    requests += 1;
    throw new Error("network should not be reached");
  }) as typeof fetch;
  const provider = new FalImageProvider({ apiKey: "test", fetchImpl: fakeFetch });

  await assert.rejects(
    () => provider.generatePack({ prompts: ["valid", "   "], aspect: "16:9", seed: 1 }),
    /blank prompts/,
  );
  await assert.rejects(
    () => provider.generatePack({ prompts: Array.from({ length: 6 }, (_, i) => `shot ${i}`), aspect: "16:9", seed: 1 }),
    /1-5 prompts/,
  );
  assert.equal(requests, 0, "invalid packs must not make paid Fal calls");
});

test("hybrid pack wrapper fails closed instead of silently regenerating continuity-breaking shots", () => {
  assert.match(hybridSource, /continuity pack returned \$\{out\.images\.length\}\/\$\{prompts\.length\} requested images/);
  assert.match(hybridSource, /image provider cannot guarantee continuity-aware pack generation/);
  assert.doesNotMatch(hybridSource, /for \(const prompt of prompts\)[\s\S]{0,240}provider\.generate/);
});

test("AI character visibility is explicit and missing legacy telemetry remains conservative", () => {
  assert.match(hybridSource, /visible_character_ids: visibleCharacterIds/);
  assert.match(qaSource, /if \(scene\.visible_character_ids !== undefined\) return scene\.visible_character_ids\.length > 0/);
  assert.match(qaSource, /return perf\[i\]\?\.characterCutIn !== "none"/);
  assert.match(qaSource, /ai_character_visibility_telemetry/);
});

test("bookend/reaction routing keys off composition mode, not scene position (engine half)", () => {
  // The Remotion-side half of this contract -- that BookendComposition and
  // ReactionComposition actually give the full-model explanation the wider
  // canvas -- lives in long-compose/tests/explanation-composition-driven-layout.test.js,
  // which runs inside long-compose's own Docker test image where
  // ExplanationScene.tsx exists.
  assert.match(hybridSource, /return plan\?\.composition_mode === "bookend"/);
});
