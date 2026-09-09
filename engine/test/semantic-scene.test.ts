import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CAPTION_CHARS,
  MAX_PHRASE_LINE_CHARS,
  extractKineticPhrase,
  kineticPhraseScene,
  threadSemanticSequence,
  validateSemanticScene,
  type SemanticScene,
} from "../src/semantic-scene.ts";

function scaleScene(overrides: Partial<SemanticScene> = {}): SemanticScene {
  return {
    kind: "scale_comparison",
    caption: "Same 20 km, two speeds",
    axis: { label: "distance", unit: "km", max: 20 },
    markers: [{ id: "walking", label: "Walking", value: 20, rate_label: "5 km/h", time_label: "4 hours" }],
    equation: "5 × 4 = 20 km",
    ...overrides,
  };
}

test("a scale comparison with an axis, units and valued markers is drawable", () => {
  assert.deepEqual(validateSemanticScene(scaleScene()), []);
});

test("a scale comparison without an axis unit is rejected as an unlabelled scale", () => {
  const errors = validateSemanticScene(scaleScene({ axis: { label: "distance", unit: "  ", max: 20 } }), "beat_006");
  assert.ok(errors.some((error) => error.includes("no unit")), errors.join(" | "));
});

test("a marker with no numeric value is rejected: it would draw as an anonymous shape", () => {
  const errors = validateSemanticScene(
    scaleScene({ markers: [{ id: "walking", label: "Walking" } as never] }),
    "beat_007",
  );
  assert.ok(errors.some((error) => error.includes("no numeric value")), errors.join(" | "));
});

test("a marker outside the axis range is rejected", () => {
  const errors = validateSemanticScene(
    scaleScene({ markers: [{ id: "walking", label: "Walking", value: 45 }] }),
    "beat_007",
  );
  assert.ok(errors.some((error) => error.includes("outside the 0-20 axis")), errors.join(" | "));
});

test("duplicate marker ids are rejected so sequence retention stays unambiguous", () => {
  const errors = validateSemanticScene(
    scaleScene({
      markers: [
        { id: "walking", label: "Walking", value: 20 },
        { id: "walking", label: "Walking again", value: 10 },
      ],
    }),
  );
  assert.ok(errors.some((error) => error.includes("duplicate")), errors.join(" | "));
});

test("a paragraph-length caption is rejected, not silently clipped at the frame edge", () => {
  const long = "The same distance takes four hours on foot but a fraction of a second electronically.";
  assert.ok(long.length > MAX_CAPTION_CHARS);
  const errors = validateSemanticScene(scaleScene({ caption: long }), "beat_008");
  assert.ok(errors.some((error) => error.includes("captions are phrases")), errors.join(" | "));
});

test("a timeline needs at least two labelled nodes", () => {
  assert.deepEqual(
    validateSemanticScene({
      kind: "timeline",
      caption: "Courier vs message",
      nodes: [
        { id: "courier", label: "Mounted courier" },
        { id: "message", label: "Phone message" },
      ],
    }),
    [],
  );
  const errors = validateSemanticScene({ kind: "timeline", caption: "One node", nodes: [{ id: "a", label: "A" }] });
  assert.ok(errors.some((error) => error.includes("at least 2 labelled nodes")), errors.join(" | "));
});

test("a kinetic phrase needs exactly one emphasis line and short lines", () => {
  assert.deepEqual(
    validateSemanticScene({
      kind: "kinetic_phrase",
      caption: "20 KM",
      lines: [{ text: "Walking", emphasis: false }, { text: "20 KM", emphasis: true }],
    }),
    [],
  );
  const noEmphasis = validateSemanticScene({
    kind: "kinetic_phrase",
    caption: "x",
    lines: [{ text: "Walking", emphasis: false }],
  });
  assert.ok(noEmphasis.some((error) => error.includes("exactly one emphasis")), noEmphasis.join(" | "));
});

test("a kinetic phrase line longer than the safe-area limit is rejected", () => {
  const errors = validateSemanticScene({
    kind: "kinetic_phrase",
    caption: "x",
    lines: [{ text: "Walking at five kilometers an hour covers twenty kilometers", emphasis: true }],
  });
  assert.ok(errors.some((error) => error.includes(`> ${MAX_PHRASE_LINE_CHARS}`)), errors.join(" | "));
});

test("kinetic phrase extraction emphasises the value, not the whole sentence", () => {
  const lines = extractKineticPhrase("Walking at five kilometers an hour covers twenty kilometers in four hours.");
  const emphasis = lines.filter((line) => line.emphasis);
  assert.equal(emphasis.length, 1);
  assert.ok(/four hours/i.test(emphasis[0]!.text), emphasis[0]!.text);
  for (const line of lines) {
    assert.ok(line.text.length <= MAX_PHRASE_LINE_CHARS, `"${line.text}" is ${line.text.length} chars`);
  }
});

test("kinetic phrase extraction never emits the source paragraph verbatim", () => {
  const source = "The same distance takes four hours on foot but a fraction of a second electronically.";
  const lines = extractKineticPhrase(source);
  assert.ok(lines.every((line) => line.text.length < source.length));
  assert.deepEqual(validateSemanticScene(kineticPhraseScene(source)), []);
});

test("kinetic phrase extraction falls back to keywords when there is no value", () => {
  const lines = extractKineticPhrase("The information no longer travels at the speed of the person carrying it.");
  assert.equal(lines.filter((line) => line.emphasis).length, 1);
  assert.deepEqual(validateSemanticScene(kineticPhraseScene("The information no longer travels at the speed of the person carrying it.")), []);
});

test("beats 6-8 of one sequence render as one evolving scale, not three resets", () => {
  const threaded = threadSemanticSequence([
    {
      kind: "scale_comparison",
      sequence_id: "speed_comparison_01",
      caption: "One shared scale",
      axis: { label: "distance", unit: "km", max: 20 },
      markers: [{ id: "origin", label: "Start", value: 0 }],
    },
    {
      kind: "scale_comparison",
      sequence_id: "speed_comparison_01",
      continuation: true,
      caption: "Walking: 4 hours",
      markers: [{ id: "walking", label: "Walking", value: 20, rate_label: "5 km/h", time_label: "4 hours" }],
      equation: "5 × 4 = 20 km",
    },
    {
      kind: "scale_comparison",
      sequence_id: "speed_comparison_01",
      continuation: true,
      caption: "Message: instant",
      markers: [{ id: "message", label: "Phone message", value: 20, time_label: "< 1 second" }],
    },
  ]);

  // The axis established by beat 6 is still the axis beats 7 and 8 draw on.
  assert.deepEqual(threaded[1]!.axis, { label: "distance", unit: "km", max: 20 });
  assert.deepEqual(threaded[2]!.axis, { label: "distance", unit: "km", max: 20 });

  // Beat 8 keeps the walking result visible for the comparison it is making.
  const finalIds = threaded[2]!.markers!.map((marker) => marker.id);
  assert.deepEqual(finalIds, ["origin", "walking", "message"]);

  // Inherited state is drawn already-complete; only the new marker animates.
  const retained = threaded[2]!.markers!.filter((marker) => marker.retained).map((marker) => marker.id);
  assert.deepEqual(retained, ["origin", "walking"]);
  assert.equal(threaded[2]!.markers!.find((marker) => marker.id === "message")!.retained, undefined);
});

test("a beat that forgets its continuation flag still inherits the shared scale", () => {
  const threaded = threadSemanticSequence([
    {
      kind: "scale_comparison",
      sequence_id: "seq",
      caption: "Scale",
      axis: { label: "distance", unit: "km", max: 20 },
      markers: [{ id: "walking", label: "Walking", value: 20 }],
    },
    { kind: "scale_comparison", sequence_id: "seq", caption: "Message", markers: [{ id: "message", label: "Message", value: 20 }] },
  ]);
  assert.equal(threaded[1]!.continuation, true);
  assert.deepEqual(threaded[1]!.axis, { label: "distance", unit: "km", max: 20 });
  assert.deepEqual(threaded[1]!.markers!.map((marker) => marker.id), ["walking", "message"]);
});

test("a beat redefining an inherited marker keeps its own version, not the retained one", () => {
  const threaded = threadSemanticSequence([
    { kind: "scale_comparison", sequence_id: "seq", caption: "a", axis: { label: "d", unit: "km", max: 20 }, markers: [{ id: "walk", label: "Walking", value: 5 }] },
    { kind: "scale_comparison", sequence_id: "seq", caption: "b", markers: [{ id: "walk", label: "Walking", value: 20, time_label: "4 hours" }] },
  ]);
  assert.equal(threaded[1]!.markers!.length, 1);
  assert.equal(threaded[1]!.markers![0]!.value, 20);
  assert.equal(threaded[1]!.markers![0]!.retained, undefined);
});

test("scenes without a sequence id are left completely untouched", () => {
  const scenes: SemanticScene[] = [
    { kind: "before_after", caption: "Then and now", before: { id: "a", label: "Courier" }, after: { id: "b", label: "Message" } },
    scaleScene(),
  ];
  assert.deepEqual(threadSemanticSequence(scenes), scenes);
});

test("separate sequences never bleed state into one another", () => {
  const threaded = threadSemanticSequence([
    { kind: "scale_comparison", sequence_id: "one", caption: "a", axis: { label: "d", unit: "km", max: 20 }, markers: [{ id: "x", label: "X", value: 1 }] },
    { kind: "scale_comparison", sequence_id: "two", caption: "b", axis: { label: "t", unit: "h", max: 4 }, markers: [{ id: "y", label: "Y", value: 2 }] },
  ]);
  assert.deepEqual(threaded[1]!.markers!.map((marker) => marker.id), ["y"]);
  assert.equal(threaded[1]!.axis!.unit, "h");
});
