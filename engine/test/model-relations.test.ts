import assert from "node:assert/strict";
import test from "node:test";
import { applyExplanationFormat } from "../src/workers/cartoon-scenes-v16.ts";

// explanation_plan@1.5.0 addresses relation endpoints by index into the raw
// model_elements array, but the compiler trims, truncates, de-duplicates and
// caps that array at 4 before the renderer ever sees it. Every test here is
// about the gap between those two index spaces: an edge that survives with
// the WRONG endpoints draws a causal claim the plan never made, which is a
// worse outcome for a viewer than the edge being dropped.

type Plan = Parameters<typeof applyExplanationFormat>[1][number];

function entryFor(scene_index: number) {
  return {
    scene_index,
    source: "template" as const,
    template_category: "cartoon",
    template_data: JSON.stringify({ characters: [{ characterId: "host", isSpeaking: true }] }),
  };
}

// A middle scene, so neither the opening nor the closing bookend rules apply.
function compile(middle: Partial<Plan>) {
  const plans = [
    { scene_index: 0, scene_role: "character-hook", visual_operation: "timeline", visual_primitive: "cause-chain" },
    {
      scene_index: 1,
      scene_role: "diagram-build",
      visual_operation: "group",
      visual_primitive: "network",
      character_cut_in: "none",
      sound_cue: "none",
      ...middle,
    },
    { scene_index: 2, scene_role: "recap", visual_operation: "payoff" },
  ] as unknown as Plan[];
  const [, scene] = applyExplanationFormat([entryFor(0), entryFor(1), entryFor(2)], plans);
  return JSON.parse(scene!.template_data) as { elements: string[]; modelRelations: Array<{ from: number; to: number; kind: string }> };
}

test("authored relations reach the renderer as indices into the cleaned element list", () => {
  const data = compile({
    model_elements: ["warm air", "updraft", "rainfall"],
    model_relations: [
      { from_element: 0, to_element: 1, kind: "causes" },
      { from_element: 1, to_element: 2, kind: "feeds" },
    ],
  });
  assert.deepEqual(data.elements, ["warm air", "updraft", "rainfall"]);
  assert.deepEqual(data.modelRelations, [
    { from: 0, to: 1, kind: "causes" },
    { from: 1, to: 2, kind: "feeds" },
  ]);
});

test("indices are remapped when cleaning drops earlier elements", () => {
  // Raw indices 1 and 2 become cleaned indices 0 and 1. Reusing the raw
  // indices would point this edge past the end of a 2-element list, silently
  // deleting the only connection the scene authored.
  const data = compile({
    model_elements: ["", "alpha", "beta"],
    model_relations: [{ from_element: 1, to_element: 2, kind: "causes" }],
  });
  assert.deepEqual(data.elements, ["alpha", "beta"]);
  assert.deepEqual(data.modelRelations, [{ from: 0, to: 1, kind: "causes" }]);
});

test("a duplicated element keeps the edge that referenced the duplicate", () => {
  // "alpha" said twice is one entity. The edge pointing at the second mention
  // must land on the surviving slot rather than being discarded.
  const data = compile({
    model_elements: ["alpha", "alpha", "beta"],
    model_relations: [{ from_element: 2, to_element: 1, kind: "blocks" }],
  });
  assert.deepEqual(data.elements, ["alpha", "beta"]);
  assert.deepEqual(data.modelRelations, [{ from: 1, to: 0, kind: "blocks" }]);
});

test("an edge into an element cut by the four-entity cap is dropped, not re-pointed", () => {
  const data = compile({
    model_elements: ["a", "b", "c", "d", "e"],
    model_relations: [
      { from_element: 0, to_element: 4, kind: "causes" },
      { from_element: 0, to_element: 3, kind: "causes" },
    ],
  });
  assert.deepEqual(data.elements, ["a", "b", "c", "d"]);
  assert.deepEqual(data.modelRelations, [{ from: 0, to: 3, kind: "causes" }],
    "the edge to the dropped fifth element must vanish, not silently attach to a surviving one");
});

test("self-loops, unknown kinds, non-integer indices and duplicates are all rejected", () => {
  const data = compile({
    model_elements: ["a", "b"],
    model_relations: [
      { from_element: 0, to_element: 0, kind: "causes" },
      { from_element: 0, to_element: 1, kind: "influences" },
      { from_element: 1.5, to_element: 0, kind: "causes" },
      { from_element: 0, to_element: 1, kind: "causes" },
      { from_element: 0, to_element: 1, kind: "causes" },
      "not an object",
      null,
    ] as unknown as Plan["model_relations"],
  });
  assert.deepEqual(data.modelRelations, [{ from: 0, to: 1, kind: "causes" }]);
});

test("relations are capped so one scene cannot author an unreadable hairball", () => {
  const data = compile({
    model_elements: ["a", "b", "c", "d"],
    model_relations: [
      { from_element: 0, to_element: 1, kind: "causes" },
      { from_element: 0, to_element: 2, kind: "causes" },
      { from_element: 0, to_element: 3, kind: "causes" },
      { from_element: 1, to_element: 2, kind: "causes" },
      { from_element: 1, to_element: 3, kind: "causes" },
      { from_element: 2, to_element: 3, kind: "causes" },
      { from_element: 3, to_element: 0, kind: "causes" },
      { from_element: 2, to_element: 0, kind: "causes" },
    ],
  });
  assert.equal(data.modelRelations.length, 6);
});

test("a plan with no relations compiles to an empty list, keeping the renderer fallback", () => {
  const data = compile({ model_elements: ["a", "b"] });
  assert.deepEqual(data.modelRelations, []);
});

test("the closing scene reuses the opening's relations, not its own", () => {
  // The closing scene already replaces its entities with the opening's for
  // continuity. Its own relations index into the entities it just lost, so
  // carrying them over would connect the opening's entities according to the
  // closing scene's unrelated topology.
  const plans = [
    {
      scene_index: 0,
      scene_role: "character-hook",
      visual_operation: "timeline",
      visual_primitive: "cause-chain",
      model_elements: ["warm air", "updraft"],
      model_relations: [{ from_element: 0, to_element: 1, kind: "causes" }],
    },
    { scene_index: 1, scene_role: "diagram-build", visual_operation: "group", visual_primitive: "network" },
    {
      scene_index: 2,
      scene_role: "recap",
      visual_operation: "payoff",
      visual_primitive: "network",
      model_elements: ["something", "else entirely", "third thing"],
      model_relations: [
        { from_element: 0, to_element: 2, kind: "blocks" },
        { from_element: 1, to_element: 2, kind: "feeds" },
      ],
    },
  ] as unknown as Plan[];
  const compiled = applyExplanationFormat([entryFor(0), entryFor(1), entryFor(2)], plans);
  const closing = JSON.parse(compiled[2]!.template_data) as { elements: string[]; modelRelations: unknown };
  assert.deepEqual(closing.elements, ["warm air", "updraft"]);
  assert.deepEqual(closing.modelRelations, [{ from: 0, to: 1, kind: "causes" }]);
});
