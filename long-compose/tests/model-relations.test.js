const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const compose = fs.readFileSync(path.join(__dirname, "../compose.js"), "utf8");
const scene = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/ExplanationScene.tsx"), "utf8");
const motion = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/MotionDesignSystem.tsx"), "utf8");

// Pulls one `if (kind === "...") { ... }` branch out of RelationEdge so each
// kind can be checked for what it actually DRAWS, rather than for the mere
// presence of its name somewhere in the file.
function relationBranch(kind) {
  const start = motion.indexOf(`if (kind === "${kind}")`);
  assert.notEqual(start, -1, `RelationEdge has no branch for kind "${kind}"`);
  const next = ["blocks", "contains", "feeds", "becomes"]
    .map((other) => motion.indexOf(`if (kind === "${other}")`))
    .filter((index) => index > start);
  const end = next.length ? Math.min(...next) : motion.indexOf("return <DirectedEdge", start);
  assert.ok(end > start, `could not bound the "${kind}" branch`);
  return motion.slice(start, end);
}

test("authored relations are wired from the compose bridge through to the renderer", () => {
  assert.match(compose, /modelRelations: Array\.isArray\(d\.modelRelations\) \? d\.modelRelations : \[\]/);
  assert.match(scene, /modelRelations\?: ModelRelation\[\]/);
  assert.match(scene, /modelRelations = \[\]/);
  assert.match(scene, /modelRelations=\{modelRelations\}/);
  assert.match(motion, /modelRelations\?: ModelRelation\[\]/);
  // Geometry must receive the REMAPPED list, never the raw prop: the display
  // list is de-duplicated and re-capped after the compiler's own cleaning.
  assert.match(motion, /relations=\{visibleRelations\}/);
  assert.doesNotMatch(motion, /relations=\{modelRelations\}/,
    "Geometry must not be handed the un-remapped prop -- indices would address the wrong marks");
});

test("each relation kind is separated by structure, not by colour alone", () => {
  // A viewer must be able to tell "A causes B" from "A blocks B" without
  // relying on hue -- the palettes go muted in several visual states, and
  // colour alone is the weakest possible distinction to hang a reversed
  // causal claim on.
  const blocks = relationBranch("blocks");
  assert.doesNotMatch(blocks, /markerEnd/,
    "a blocked edge must not carry an arrowhead into its target -- that asserts the target IS reached");
  assert.match(blocks, /0\.6/, "the blocked stroke must stop short of the target");

  const contains = relationBranch("contains");
  assert.match(contains, /<circle/, "containment must draw an enclosure, not a line to a point");
  assert.doesNotMatch(contains, /markerEnd/, "an enclosure is not a directed transfer");

  const feeds = relationBranch("feeds");
  assert.match(feeds, /phase \+ offset/,
    "supply must keep moving after progress completes -- that is what separates feeds from causes");

  const becomes = relationBranch("becomes");
  assert.match(becomes, /strokeDasharray="10 10"/,
    "the provisional half of a transition must be dashed against the asserted half");
  assert.match(becomes, /markerEnd/);
});

test("the authored network layout is never overwritten by the visual operation", () => {
  // Regression: the first version of this branch laid entities out and then
  // passed them through operatePoint like every other primitive. `group`
  // relocated all of them onto its two fixed cluster centres, collapsing the
  // authored graph into an illegible knot. For every other primitive the
  // marks are interchangeable and operatePoint rearranging them is the point;
  // here the positions ARE the content.
  const start = motion.indexOf("if (primitive === \"network\")");
  assert.notEqual(start, -1);
  const fallback = motion.indexOf("const bases: Point[]=[[160,125]", start);
  assert.ok(fallback > start, "the pre-1.5.0 fallback topology must still be present");
  const authored = motion.slice(start, fallback);
  assert.match(authored, /relations\.length > 0 && labels\.length >= 2/);
  // Matches a CALL, not the identifier: the branch documents why it does not
  // use operatePoint, and a bare-identifier check would fail on that comment.
  assert.doesNotMatch(authored, /operatePoint\(/,
    "the authored graph's node positions carry meaning and must not be relocated by the operation");
});

test("a plan with no authored relations still renders the previous fixed topology", () => {
  // The fallback is what keeps a resumed pre-1.5.0 plan, or a scene the
  // planner legitimately left with an empty relation list, from degrading to
  // an empty frame.
  const start = motion.indexOf("if (primitive === \"network\")");
  const body = motion.slice(start, motion.indexOf("if (primitive === \"hierarchy\")", start));
  assert.match(body, /\[\[160,125\],\[390,80\],\[700,105\],\[925,210\],\[780,400\],\[470,385\],\[150,325\]\]/);
  assert.match(body, /links: Array<\[number,number\]>/);
});

test("relationship primitives that draw explicit edges honour the authored kind", () => {
  // cause-chain, one-to-many and hierarchy each draw edges between named
  // entities, so each must consult kindBetween rather than hardcoding a
  // neutral arrow.
  assert.match(motion, /const kindBetween = \(from: number, to: number\): string =>/);
  const chain = motion.slice(motion.indexOf('if (primitive === "cause-chain")'), motion.indexOf('if (primitive === "before-after")'));
  assert.match(chain, /<RelationEdge[^>]*kind=\{kindBetween\(i,i\+1\)\}/);
  const oneToMany = motion.slice(motion.indexOf('if (primitive === "one-to-many")'), motion.indexOf('if (primitive === "many-to-one")'));
  assert.match(oneToMany, /<RelationEdge[^>]*kind=\{kindBetween\(0,i\)\}/);
  const hierarchy = motion.slice(motion.indexOf('if (primitive === "hierarchy")'), motion.indexOf('if (primitive === "one-to-many")'));
  assert.match(hierarchy, /<RelationEdge[^>]*kind=\{kindBetween\(0,i\)\}/);
});

test("an unauthored direction falls back to neutral styling rather than borrowing the reverse edge", () => {
  const lookup = motion.slice(motion.indexOf("const kindBetween"), motion.indexOf("if (primitive === \"particles\")"));
  assert.match(lookup, /relation\.from === from && relation\.to === to/);
  assert.doesNotMatch(lookup, /relation\.from === to && relation\.to === from/,
    "matching an edge in reverse would draw the causality backwards");
  assert.match(lookup, /\?\? "causes"/);
});
