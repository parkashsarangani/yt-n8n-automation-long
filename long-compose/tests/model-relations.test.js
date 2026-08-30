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

test("an entity with no icon renders its own words, never an invented shape", () => {
  // Watch feedback on run_a41a8e2e, pointing at a red cross inside a box:
  // "what's the point of these boxes or triangles? Replace them with animated
  // text." EntityMark used to hash the entity id into one of six polygons and
  // one of six colours. For a concrete noun the resolved Iconify icon carries
  // meaning; for "vacuum gap" or "heat loss" the viewer got a shape that
  // stood for nothing -- decoration shaped like information, which invites
  // someone to decode a symbol with nothing to decode.
  const mark = motion.slice(motion.indexOf("export function EntityMark"), motion.indexOf("\nfunction Dot("));
  assert.ok(mark.length > 0, "EntityMark moved");
  for (const invented of ["<polygon", "hexPoints", "rotate(45"]) {
    assert.ok(!mark.includes(invented), `EntityMark still invents a shape (${invented})`);
  }
  // The icon path stays -- a real icon is the good case, not the problem.
  assert.match(mark, /if \(icon\)/);
  // …and the fallback is the entity's own text, animated in.
  assert.match(mark, /const text = \(label \?\? ""\)\.trim\(\);/);
  assert.match(mark, /spring\(\{ frame, fps/);
  assert.match(mark, /<tspan/);
});

test("the contradiction state no longer slashes a red mark across the diagram", () => {
  // Same feedback. StateDecorator drew two red zigzags at fixed coordinates
  // in the middle of the canvas, on top of whatever the diagram was, so a
  // contradiction scene got a stray glyph over its content. The state is
  // already carried by the palette, by dashed provisional geometry, and by
  // Geometry cross-fading the failing model into the corrected one.
  const decorator = motion.slice(motion.indexOf("function StateDecorator"), motion.indexOf("export function MotionDesignSystem"));
  assert.ok(decorator.length > 0, "StateDecorator moved");
  assert.match(decorator, /if \(state === "contradiction"\) return null;/);
  assert.ok(!/contradiction"\) return <g/.test(decorator), "the contradiction overlay is back");
});

test("a caption is suppressed when the mark itself already renders the words", () => {
  // Otherwise a diagram prints the same phrase twice, once as the mark and
  // once as its caption pill.
  assert.match(motion, /const captionFor = \(index: number\) => \{/);
  assert.match(motion, /entityIcons\?\.\[key\] \? \(labels\[index\] \?\? ""\) : ""/);
  // Rings and shells are the exception: they draw no mark at all, so their
  // caption is the only thing naming them and must never be gated.
  const nested = motion.slice(motion.indexOf('if (primitive === "nested-context")'), motion.indexOf('if (primitive === "cycle")'));
  assert.match(nested, /<Label text=\{layer\.label\}/);
});

test("containment nests the container outside the thing it contains", () => {
  // A real plan authored "thermos CONTAINS vacuum gap" and the renderer drew
  // the thermos as the innermost core inside the vacuum gap -- the
  // containment stated backwards by the one primitive whose entire job is
  // containment.
  const nested = motion.slice(motion.indexOf('if (primitive === "nested-context")'), motion.indexOf('if (primitive === "cycle")'));
  assert.match(nested, /depth\[relation\.to\] = Math\.max\(depth\[relation\.to\]!, depth\[relation\.from\]! \+ 1\)/);
  assert.match(nested, /\.sort\(\(a, b\) => depth\[a\]! - depth\[b\]!\)/);
  // An entity the plan never nested is not a layer of anything.
  assert.match(nested, /const outside = /);
});

test("a container primitive defers to the relation graph when its relations are directional", () => {
  // nested-context/shells/overlapping-sets all assert containment. With
  // `blocks` or `causes` relations that assertion is false: a real episode
  // drew "vacuum gap BLOCKS conduction, conduction CAUSES heat loss" as three
  // nested boxes, which says heat loss contains conduction contains the gap.
  assert.match(motion, /const CONTAINMENT_PRIMITIVES = new Set\(\["nested-context", "shells", "overlapping-sets"\]\)/);
  assert.match(motion, /const hasDirectionalRelation = relations\.some\(\(relation\) => relation\.kind !== "contains"\)/);
  assert.match(motion, /if \(hasDirectionalRelation && CONTAINMENT_PRIMITIVES\.has\(primitive\) && entityCount >= 2\) \{/);
});

test("a branch with a fixed source orients its edge by the authored direction", () => {
  // kindBetween deliberately refuses to match an edge backwards, because a
  // kind applied to a reversed edge states the opposite claim. rays has a
  // natural source at its centre but the plan may author "silvered wall
  // BLOCKS infrared" the other way round, and drawing that as a
  // source->target arrow asserts the reverse of the narration.
  assert.match(motion, /const relationBetween = \(a: number, b: number\) =>/);
  const rays = motion.slice(motion.indexOf('if (primitive === "rays")'), motion.indexOf('if (primitive === "wave")'));
  assert.match(rays, /const reversed = relation \? relation\.from === entityIndex : false;/);
  assert.match(rays, /kind=\{relation\?\.kind \?\? "causes"\}/);
});

test("every primitive that names entities draws all of them, not just the first", () => {
  // The root cause of "the motion graphics are irrelevant": 8 of 21 scenes in
  // a real episode drew ZERO authored entities, and most of the rest drew one
  // of three. The cap that governs how many entities reach Geometry has to
  // include every primitive that now draws one mark per entity, or the extra
  // entities are discarded before the drawing code ever sees them.
  const capped = motion.slice(motion.indexOf("const MULTI_ENTITY_PRIMITIVES"), motion.indexOf("]);", motion.indexOf("const MULTI_ENTITY_PRIMITIVES")));
  for (const primitive of ["nested-context", "shells", "rays", "path", "facets-around-center", "overlapping-sets"]) {
    assert.ok(capped.includes(`"${primitive}"`), `${primitive} draws per-entity marks but is still capped at two entities`);
  }
});

test("a scene with nothing depictable states its model as animated text, not a graph", () => {
  // Watch feedback on the rays frame: "does this make sense? I would prefer a
  // broll or animated text instead." It did not make sense. When no entity in
  // a scene resolves an icon -- "infrared", "vacuum gap", "heat loss" are
  // abstractions -- every mark falls back to text and the diagram becomes
  // three words joined by lines: a graph OF THE SENTENCE, which tells a
  // viewer nothing the narration did not.
  assert.match(motion, /function KineticStatement\(/);
  assert.match(motion, /const anyIconResolved = /);
  // `counter` is excluded whatever the primitive: its visual is items
  // activating one by one as the number climbs, which is a real thing to
  // watch. The render regression caught counter/objects going static when
  // this gate first took it over.
  assert.match(motion, /if \(!anyIconResolved && entityCount >= 2 && operation !== "counter" && NODE_DIAGRAM_PRIMITIVES\.has\(primitive\)\) \{/);
  // Primitives that draw a real subject rather than labelled nodes keep their
  // own composition -- a wave or a quantity still shows the viewer something.
  const gate = motion.slice(motion.indexOf("const NODE_DIAGRAM_PRIMITIVES"), motion.indexOf("const anyIconResolved"));
  for (const subject of ["wave", "spectrum", "quantity", "before-after", "horizon"]) {
    assert.ok(!gate.includes(`"${subject}"`), `${subject} draws a real subject and must keep its own composition`);
  }
});

test("the kinetic statement names the relation in words and orders rows along the chain", () => {
  const kinetic = motion.slice(motion.indexOf("function KineticStatement("), motion.indexOf("function Geometry("));
  // The relation word does work no arrow can: "blocks" is unambiguous where a
  // barred line is not.
  assert.match(kinetic, /\{link\.kind\}<\/text>/);
  // Rows follow the authored edges so related entities land adjacent.
  // Listing them in plan order dropped real relations: a scene relating 1->0
  // and 0->2 could only ever show the 0-1 link.
  assert.match(kinetic, /for \(const row of present\) if \(!hasIncoming\.has\(row\.index\)\) visit\(row\.index\);/);
  assert.match(kinetic, /const rowIndices = order\.length \? order : present\.map\(\(row\) => row\.index\);/);
  // A `blocks` stem stops at the bar; a full stem through a full bar renders
  // as a plus sign, which reads as "and" rather than "stopped".
  assert.match(kinetic, /blocks \? `M540 \$\{linkY - 32\} L540 \$\{linkY - 4\}`/);
  // Rows land in sequence rather than all at once.
  assert.match(kinetic, /frame: frame - i \* Math\.round\(fps \* 0\.34\)/);
});
