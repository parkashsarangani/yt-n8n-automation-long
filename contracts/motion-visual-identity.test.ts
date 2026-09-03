// Cross-package contract, historical half (RFC 0008): engine/ no longer has
// any AI-prompt path that generates motion-graphics entity identity tokens
// -- hybrid_visual_assets, the only producer, was retired along with the
// two-host character pipeline -- so engine's copies of
// motion-visual-identity.ts/motion-compatibility.json were deleted outright
// rather than kept in sync for nothing. long-compose/ keeps its own copies
// independently: its Remotion renderer must still be able to replay
// historical episodes rendered under the old contract, which has nothing to
// do with what engine currently produces. This file now only pins
// long-compose's own internal consistency (renderer source vs. its own
// checked-in contract copy), not a three-way sync.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const motionSource = readFileSync(
  new URL("../long-compose/remotion/src/compositions/MotionDesignSystem.tsx", import.meta.url),
  "utf8",
);

// The canonical values themselves (background + the six deterministic entity
// colours) used to live in engine/src/motion-visual-identity.ts, read here
// via a cross-package import. Now that engine has no consumer left, this file
// is that contract's only remaining home -- long-compose's renderer is
// checked directly against it, not against an engine copy.
const MOTION_BG = "#08101E";
const MOTION_ENTITY_COLORS = ["#FFD166", "#65C7F7", "#7DE2A8", "#B794F4", "#FF7D7D", "#5DE0C6"];

test("long-compose's own Remotion EntityMark contract is internally consistent", () => {
  assert.ok(motionSource.includes(MOTION_BG), `renderer missing background ${MOTION_BG}`);
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
});

function schemaBlueprintMap(schemaFile: Record<string, unknown>): Record<string, string[]> {
  const schema = schemaFile.json_schema as Record<string, unknown>;
  const itemSchema = ((schema.properties as Record<string, unknown>).scenes as Record<string, unknown>).items as Record<string, unknown>;
  const allOf = itemSchema.allOf as Array<Record<string, unknown>>;
  const result: Record<string, string[]> = {};
  for (const conditional of allOf) {
    const mode = ((((conditional.if as Record<string, unknown>)?.properties as Record<string, unknown>)?.representation_mode as Record<string, unknown>)?.const);
    if (typeof mode !== "string") continue;
    const sceneBlueprint = (((conditional.then as Record<string, unknown>)?.properties as Record<string, unknown>)?.scene_blueprint as Record<string, unknown>);
    if (!sceneBlueprint) continue;
    if (typeof sceneBlueprint.const === "string") result[mode] = [sceneBlueprint.const];
    if (Array.isArray(sceneBlueprint.enum)) result[mode] = sceneBlueprint.enum as string[];
  }
  return result;
}

// engine/src/semantic-representation.json (the third former leg of this
// contract) was deleted along with its only consumer, semantic-visual-assets
// (RFC 0008 retired the two-host character pipeline). explanation_plan's
// schema stays -- historical episodes still need to validate and replay --
// so this now pins that schema plus long-compose's own renderer copy against
// the canonical contract, not an engine copy that no longer exists.
test("semantic representation compatibility stays synchronized across schema and renderer", () => {
  const canonical = JSON.parse(readFileSync(new URL("./semantic-representation.json", import.meta.url), "utf8"));
  const renderer = JSON.parse(readFileSync(new URL("../long-compose/remotion/src/semantic/semantic-representation.json", import.meta.url), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../engine/schemas/explanation_plan/1.6.0.json", import.meta.url), "utf8"));

  assert.deepEqual(renderer, canonical);
  assert.deepEqual(schemaBlueprintMap(schema), canonical);
});
