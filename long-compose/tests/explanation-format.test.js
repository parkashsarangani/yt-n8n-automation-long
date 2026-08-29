const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = fs.readFileSync(path.join(__dirname, "../remotion/src/Root.tsx"), "utf8");
const compose = fs.readFileSync(path.join(__dirname, "../compose.js"), "utf8");
const scene = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/ExplanationScene.tsx"), "utf8");
const motion = fs.readFileSync(path.join(__dirname, "../remotion/src/compositions/MotionDesignSystem.tsx"), "utf8");

test("visual operation is wired from compose bridge to Remotion", () => {
  assert.match(compose, /explanation:\s*\{/);
  assert.match(compose, /compositionId: "ExplanationScene"/);
  assert.match(compose, /visualOperation: d\.visualOperation/);
  assert.match(compose, /visualPrimitive: d\.visualPrimitive/);
  assert.match(compose, /visualState: d\.visualState/);
  assert.match(compose, /numericValue: Number\.isFinite/);
  assert.match(compose, /compositionMode: d\.compositionMode/);
  assert.match(root, /id="ExplanationScene"/);
  assert.match(root, /visualOperation: "timeline"/);
  assert.match(compose, /templateName === "explanation"/);
});

test("renderer implements every concrete operation", () => {
  // Operations live in MotionDesignSystem's OperationStage, not in
  // ExplanationScene. Before the composable refactor these literals were
  // asserted against ExplanationScene, where they sat inside SemanticCanvas /
  // OperationCanvas -- components the refactor stopped calling but left in the
  // file. That kept this test green against ~240 lines of unreachable code
  // while the real render path went through MotionDesignSystem. The dead
  // components are now deleted and the assertions point at the live renderer.
  for (const operation of ["stack", "timeline", "counter", "compress", "group", "sort", "scale-compare", "payoff"]) {
    assert.match(motion, new RegExp(`"${operation}"`));
  }
  assert.match(motion, /durationInFrames/);
  assert.match(motion, /Easing\.inOut/);
  // Primitive, operation and state must all reach one composed renderer --
  // that separation is the point of the refactor, so assert the real call.
  assert.match(scene, /<MotionDesignSystem\b[^>]*\bprimitive=\{visualPrimitive\}/);
  assert.match(scene, /<MotionDesignSystem\b[^>]*\boperation=\{visualOperation\}/);
  assert.match(scene, /<MotionDesignSystem\b[^>]*\bstate=\{visualState\}/);
  // Geometry (what exists) must stay separate from the operation transform
  // (what happens to it), rather than each primitive hardcoding its animation.
  assert.match(motion, /function Geometry/);
  assert.match(motion, /function OperationStage/);
});

test("dead pre-refactor canvases are gone, not just bypassed", () => {
  assert.doesNotMatch(scene, /function SemanticCanvas/);
  assert.doesNotMatch(scene, /function OperationCanvas/);
});

test("renderer depicts semantic subjects instead of naming generic cards", () => {
  for (const primitive of ["particles", "rays", "wave", "horizon", "spectrum", "path", "shells", "objects"]) {
    assert.match(motion, new RegExp(`"${primitive}"`));
  }
  assert.match(motion, /function Geometry/);
  assert.match(motion, /Array\.from\(\{ length: 28 \}/);
  assert.match(motion, /<polyline points=\{points\}/);
  assert.match(motion, /primitive === "horizon"/);
  assert.match(motion, /primitive === "shells"/);
  assert.match(motion, /primitive === "objects"/);
  assert.match(scene, /function PayoffResolution/);
  assert.match(scene, /visualOperation === "payoff"/);
  assert.match(scene, /durationInFrames \* 0?\.62/);
  assert.match(motion, /operation === "compress"/);
  assert.match(motion, /operation === "group"/);
  assert.match(motion, /operation === "sort"/);
  assert.match(motion, /operation === "stack"/);
  assert.match(motion, /operation === "scale-compare"/);
});

test("reaction characters use deliberate bust panels", () => {
  assert.match(scene, /function BustReactionPanel/);
  // 1.4, not 1.45: the panel is now an overlay rather than half the canvas
  // (see the comment above BustReactionPanel), so the character is scaled
  // down slightly to fit the narrower width without cropping.
  assert.match(scene, /scale=\{1\.4\}/);
  assert.match(scene, /y=\{430\}/);
  assert.match(scene, /borderRadius: 38/);
  assert.doesNotMatch(scene, /scale=\{0\.58\}/);
  assert.doesNotMatch(scene, /function CharacterRail/);
  // 60, not 56: the opening/closing title got a deliberate size bump.
  assert.match(scene, /fontSize: 60/);
  assert.match(scene, /PRIMITIVE_GLOW/);
});

test("model labels stay legible in the narrowest 1280x720 bookend", () => {
  const viewBox = motion.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(viewBox, "expected the model SVG to declare a viewBox");
  const svgWidth = Number(viewBox[1]);
  const compositionWidth = 1920;
  const outputWidth = 1280;
  const narrowestStageWidth = compositionWidth - 86 - 850;
  const scale = narrowestStageWidth / svgWidth * (outputWidth / compositionWidth);

  const labelFloor = Number(motion.match(/Math\.max\((\d+), Math\.min\(54/)?.[1]);
  assert.ok(Number.isFinite(labelFloor), "expected a deterministic SVG label floor");
  const effective = labelFloor * scale;
  assert.ok(effective >= 28, "model labels render at " + effective.toFixed(1) + "px in the narrowest bookend, below the 28px floor");
  assert.match(motion, /const labelLines/);
  assert.doesNotMatch(motion, /text\.slice\(0, 20\)/, "labels must wrap or disappear, never truncate mid-word");
  // MAX_LABELS caps a diagram at one central label plus two supporting ones
  // (was 4 on timeline/cause-chain) -- more read as competing clutter per the
  // watchability pass, even with a collision-free slot for each.
  assert.match(motion, /const MAX_LABELS = 3/);
  // The ENTITY cap is separate from the LABEL cap: primitives that draw one
  // mark per authored entity (a funnel's sources, a chain's steps) must keep
  // all 4, or the diagram renders an incomplete model and the dropped
  // entities also lose their resolved icons -- caught on a live render of
  // the many-to-one funnel, which showed only 2 of 4 sources. MAX_LABELS
  // still governs how many of those marks get visible text.
  assert.match(motion, /const MULTI_ENTITY_PRIMITIVES = new Set/);
  assert.match(motion, /multiEntity = MULTI_ENTITY_PRIMITIVES\.has\(primitive\) \|\| operation === "timeline"/);
  assert.match(motion, /pairs\.slice\(0, multiEntity \? 4 : 2\)/);
});

test("production metadata is never rendered as a viewer-facing label", () => {
  assert.doesNotMatch(scene, /role\.replaceAll/);
  assert.doesNotMatch(scene, /textTransform: "uppercase"/);
});

test("captions are larger, raised, shorter, and omit speaker prefixes", () => {
  assert.match(compose, /Style: Caption,Inter Bold,80/);
  assert.match(compose, /,110,110,194,1/);
  assert.match(compose, /const WORDS_PER_PHRASE = 5/);
  assert.doesNotMatch(compose, /speakerName\.toUpperCase/);
  assert.match(compose, /tightenExplanationTail/);
  // The preserved response beat is parameterised now: an ordinary turn keeps
  // 0.16s (within the 120-250ms range that reads as a natural reply), while a
  // scene handing off into a reversal/payoff keeps a longer, distinct beat.
  assert.match(compose, /start_silence=\$\{preserveSilenceSeconds\}/);
  assert.match(compose, /REVERSAL_TAIL_SILENCE_SECONDS = 0\.45/);
  assert.match(compose, /nextIsReversal/);
});

test("sound design follows operations and preserves a restrained payoff", () => {
  assert.match(compose, /operationFallback/);
  assert.match(compose, /visualStateFallback/);
  assert.match(compose, /explanationMode \? "" : comment_hook/);
  // Raised from 10/1.8s: retention research singles out sound design tied to
  // every visual change as the single biggest retention lever, and the old
  // cap left roughly 60% of a typical 15-17 scene episode with no cue at
  // all. Still bounded, not unlimited -- a continuous barrage of clicks is
  // its own retention risk.
  assert.match(compose, /sfxEvents\.length >= 20/);
  assert.match(compose, /time - lastCueTime < 1\.3/);
  assert.match(compose, /explanationMode \? 0\.11 : 0\.15/);
  assert.match(compose, /volume: 0\.14/);
  assert.match(compose, /operationPhase/);
  assert.match(compose, /data\.visualOperation === "payoff"/);
  assert.match(compose, /0\.74/);
});


test("motion design system implements all relationship primitives with staged change", () => {
  for (const primitive of ["network", "hierarchy", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context", "cycle", "cause-chain", "before-after", "map", "timeline", "quantity", "spectrum", "physical-transformation"]) {
    assert.match(motion, new RegExp(`"${primitive}"`));
  }
  for (const state of ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"]) {
    assert.match(motion, new RegExp(`"${state}"`));
  }
  assert.match(motion, /setup/);
  assert.match(motion, /transform/);
  assert.match(motion, /consequence/);
  assert.match(motion, /hold/);
  assert.match(motion, /strokeDasharray/);
  assert.match(motion, /state === "hypothesis"/);
  assert.match(motion, /state === "contradiction"/);
  assert.doesNotMatch(motion, /const wrong = state === "hypothesis" \|\| state === "contradiction"/);
  assert.match(motion, /Math\.max\(47, Math\.min\(54/);
  assert.match(scene, /MotionDesignSystem/);
});

test("middle scenes suppress slide headings and canonical entities retain identity", () => {
  assert.match(scene, /showTitle = compositionMode === "bookend" && !isPayoff/);
  assert.match(scene, /\{showTitle \? <Title>/);
  assert.match(motion, /const hashText/);
  assert.match(motion, /function EntityMark/);
  // identityKeys (from entityIdentityKeys, a compiler-supplied proxy for
  // "same entity, possibly reworded") seeds EntityMark's shape/colour hash
  // ahead of the raw display label, so a mark stays visually stable within a
  // scene even when the label wording shifts. Extracted to a local `eid` so
  // the same id also drives the entityIcons lookup below, rather than
  // duplicating the identityKeys/labels fallback chain per prop.
  assert.match(motion, /eid\s*=\s*identityKeys\[i\]\s*\|\|\s*labels\[i\]/);
  assert.match(scene, /entityIdentityKeys/);
});

test("real icons resolved server-side take priority over EntityMark's hash-picked shape", () => {
  // entityIcons is additive to the identity/colour contract above, not a
  // replacement: an entity with no confident icon match keeps today's
  // arbitrary-but-stable shape exactly as before this existed.
  assert.match(motion, /export type EntityIconMap/);
  assert.match(motion, /icon\?\s*:\s*\{\s*viewBox:\s*string;\s*body:\s*string\s*\}/);
  assert.match(motion, /if \(icon\) \{/);
  assert.match(motion, /dangerouslySetInnerHTML/);
  assert.match(motion, /entityIcons\?\.\[eid\]/);
  assert.match(scene, /entityIcons/);
  assert.match(compose, /entityIcons: d\.entityIcons \|\| \{\}/);
});

test("before-after boxes carry an entity mark, not just colour and text", () => {
  // The two before-after boxes were plain colour-filled rects with only a
  // text label -- real watch feedback (run_ad5bd430) called this primitive
  // out by name as "stupid and not matching". EntityMark gives each box an
  // actual picture, same icon-over-hash-shape contract as every other
  // EntityMark call site.
  assert.match(motion, /primitive === "before-after"/);
  assert.match(motion, /rightId\s*=\s*identityKeys\[1\]\s*\|\|\s*identityKeys\[0\]/);
  assert.match(motion, /<EntityMark id=\{identityKeys\[0\]\} icon=\{leftIcon\}/);
  assert.match(motion, /<EntityMark id=\{rightId\} icon=\{rightIcon\}/);
});

test("the payoff visually retraces the episode's mechanism, not just a decorative ring", () => {
  // Watch feedback: "the text supplies the conclusion while the animation
  // supplies decoration... the final visual should reconstruct that
  // mechanism". EntityMark must be exported for ExplanationScene to use it,
  // and the payoff chain must actually be wired to the scene's own reused
  // entities (elements/entityIdentityKeys/entityIcons), not a fixed prop.
  assert.match(motion, /export function EntityMark/);
  assert.match(scene, /function MechanismChain/);
  assert.match(scene, /entities\.length < 2\) return null/);
  assert.match(scene, /<PayoffResolution before=\{before\} after=\{after\} keyText=\{keyText\} elements=\{elements\} entityIdentityKeys=\{entityIdentityKeys\} entityIcons=\{entityIcons\}/);
  // Payoff-state geometry is established as always green (see the
  // accentCopyBlocks regression test) -- a chain icon landing on the same
  // hash-derived accent gold as the closing text purely by coincidence would
  // read as a second, duplicated block of closing copy. Confirmed by an
  // actual regression run before this override was added.
  assert.match(motion, /color\?\s*:\s*string/);
  assert.match(scene, /<EntityMark id=\{id\} icon=\{entityIcons\[id\]\} color=\{GREEN\}/);
});

test("reaction panels interact with the model and payoff removes secondary copy", () => {
  assert.match(scene, /function CharacterModelInteraction/);
  assert.match(scene, /data-character-model-interaction="true"/);
  // Raised from 0.04: MotionDesignSystem now actually suppresses payoff's
  // labels/keyText/rings at the source (isPayoffState), rather than relying
  // on this wrapper to hide a diagram that was still drawing its own copy of
  // the closing statement underneath -- so dimming it to near-zero is no
  // longer needed to hide leftover content.
  assert.match(scene, /opacity: isPayoff \? 0?\.22 : 1/);
  const payoff = scene.slice(scene.indexOf("function PayoffResolution"), scene.indexOf("export const ExplanationScene"));
  assert.doesNotMatch(payoff, /\{before \? <div/, "payoff must not render the old hypothesis as secondary copy");
});


test("geometry, operation, state, and composition are independent renderer layers", () => {
  assert.match(motion, /function Geometry/);
  assert.match(motion, /function OperationStage/);
  assert.match(motion, /function StateDecorator/);
  assert.match(motion, /<OperationStage operation=\{operation\}/);
  assert.match(scene, /function BookendComposition/);
  assert.match(scene, /function FullModelComposition/);
  assert.match(scene, /function ReactionComposition/);
  assert.match(scene, /<CompositionFrame mode=\{compositionMode\}/);
  assert.match(scene, /operation=\{visualOperation\}/);
});

test("quantity graphics use authored data instead of a fixed count", () => {
  assert.match(motion, /numericValue/);
  assert.match(motion, /Number\.isFinite\(numericValue\)/);
  assert.doesNotMatch(motion, /Math\.round\(transform\*40\)/);
});
