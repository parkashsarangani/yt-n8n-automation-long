import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MOTION_BG,
  MOTION_ENTITY_COLORS,
  MOTION_ENTITY_SHAPES,
  motionEntityHash,
  motionEntityVisualTokens,
} from "../src/motion-visual-identity.ts";
import {
  TEMPLATE_DATA_MAX_LENGTH,
  templateDataWithinLimit,
} from "../src/workers/hybrid-visual-assets.ts";
import { FalImageProvider } from "../src/providers/fal.ts";

const hybridSource = readFileSync(new URL("../src/workers/hybrid-visual-assets.ts", import.meta.url), "utf8");
const qaSource = readFileSync(new URL("../src/workers/qa.ts", import.meta.url), "utf8");
const motionSource = readFileSync(new URL("../../long-compose/remotion/src/compositions/MotionDesignSystem.tsx", import.meta.url), "utf8");
const explanationSource = readFileSync(new URL("../../long-compose/remotion/src/compositions/ExplanationScene.tsx", import.meta.url), "utf8");

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

test("bookend and reaction spatial allocation is composition-driven, not scene-position-driven", () => {
  assert.match(explanationSource, /function BookendComposition[\s\S]*?<ContentStage right=\{610\}/);
  assert.match(explanationSource, /function ReactionComposition[\s\S]*?panelMode === "both" \? 610 : 380/);
  assert.match(hybridSource, /return plan\?\.composition_mode === "bookend"/);
});

test("engine AI identity tokens stay byte-for-byte compatible with Remotion EntityMark contract", () => {
  assert.equal(MOTION_BG, "#08101E");
  for (const color of MOTION_ENTITY_COLORS) assert.ok(motionSource.includes(color), `renderer missing ${color}`);
  assert.match(motionSource, /hash \* 31 \+ char\.charCodeAt\(0\)/);
  assert.match(motionSource, /2166136261/);
  assert.match(motionSource, /const shape = Math\.floor\(hash \/ colors\.length\) % 6/);

  const ids = ["entity-alpha", "entity-beta", "entity-gamma", "entity-delta"];
  const tokens = motionEntityVisualTokens(ids);
  for (const token of tokens) {
    const hash = motionEntityHash(token.entity_id);
    assert.equal(token.color, MOTION_ENTITY_COLORS[hash % MOTION_ENTITY_COLORS.length]);
    assert.equal(token.shape, MOTION_ENTITY_SHAPES[Math.floor(hash / MOTION_ENTITY_COLORS.length) % MOTION_ENTITY_SHAPES.length]);
  }
});
