// Cross-package contract: engine's AI-prompt entity identity tokens must stay
// byte-for-byte compatible with the Remotion EntityMark renderer, so a cut
// from motion graphics into AI-generated imagery preserves an entity's color
// and shape rather than only its wording. engine/ and long-compose/ build as
// two separate, isolated Docker contexts (see .github/workflows/ci.yml), so
// this check runs once here, directly on the CI runner's raw checkout, where
// both trees exist side by side -- not inside either package's own test
// suite, which never has the other package's source available.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MOTION_BG,
  MOTION_ENTITY_COLORS,
  motionEntityHash,
  motionEntityVisualTokens,
} from "../engine/src/motion-visual-identity.ts";

const motionSource = readFileSync(
  new URL("../long-compose/remotion/src/compositions/MotionDesignSystem.tsx", import.meta.url),
  "utf8",
);

test("engine AI identity tokens stay byte-for-byte compatible with Remotion EntityMark contract", () => {
  assert.equal(MOTION_BG, "#08101E");
  for (const color of MOTION_ENTITY_COLORS) assert.ok(motionSource.includes(color), `renderer missing ${color}`);
  assert.match(motionSource, /hash \* 31 \+ char\.charCodeAt\(0\)/);
  assert.match(motionSource, /2166136261/);
  // Shape is deliberately NOT part of this contract any more. The renderer
  // used to hash an entity id into one of six polygons and the AI prompt asked
  // for the matching silhouette. The symbol was arbitrary -- "vacuum gap"
  // became a plus -- and EntityMark now renders the entity's own words when no
  // real icon resolves, so there is nothing on the motion-graphics side for a
  // silhouette to match.
  assert.ok(!/const shape = Math\.floor\(hash \/ colors\.length\)/.test(motionSource),
    "EntityMark is inventing hash-picked shapes again");
  // What the two sides still share is COLOUR, and the text fallback has to use
  // the same hash-derived fill or an entity changes identity the moment its
  // icon lookup misses.
  assert.match(motionSource, /const fill = color \?\? colors\[hash % colors\.length\]!;/);
  assert.match(motionSource, /<text textAnchor="middle" fill=\{fill\}/);

  const ids = ["entity-alpha", "entity-beta", "entity-gamma", "entity-delta"];
  const tokens = motionEntityVisualTokens(ids);
  for (const token of tokens) {
    const hash = motionEntityHash(token.entity_id);
    assert.equal(token.color, MOTION_ENTITY_COLORS[hash % MOTION_ENTITY_COLORS.length]);
    assert.ok(!("shape" in token), "shape is no longer part of the cross-package identity contract");
  }
});
