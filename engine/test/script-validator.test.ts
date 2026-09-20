/**
 * The script prompt's numeric rules were prose until now, and real drafts
 * broke them while passing every gate. The fixtures below are built from the
 * two 2026-09-19 production drafts that did exactly that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  validateScriptStructure,
  summariseViolations,
  parseScenes,
  SCENE_WORD_CAP,
  FIRST_REPLY_WORD_CEILING,
} from "../src/script-validator.ts";

function words(n: number, seed = "word"): string {
  return Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
}

function scene(point: string, narration: string, extra: Record<string, unknown> = {}) {
  return { scene_index: 0, point, narration, ...extra };
}

/** A structurally sound episode: every rule satisfied. */
function soundScript() {
  return {
    scenes: [
      scene("[scenario] An idea loses its author", `Do you ever sit in a meeting and hear your own idea repeated back as someone else's? ${words(14)} "That was my plan."`),
      scene("[response_a] The correction becomes a dispute", `${words(25)} "Actually, that was mine."`),
      scene("[response_b] Name the work", `${words(25)} "I drafted the pilot."`),
      scene("[explanation] Separate the contributions", words(40)),
      scene("[limitations] Uneven stakes", words(30)),
      scene("[exercise] Rehearse one sentence", words(30)),
      scene("[payoff] Answer for your design", `${words(30)} "Why two days?" she asks. Which would you choose?`),
      scene("[bridge] When the boss takes credit", words(15), { is_outro: true }),
    ],
  };
}

test("a structurally sound script produces no violations", () => {
  const result = validateScriptStructure(soundScript());
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.equal(result.ok, true);
});

test("the 150-word scene that shipped on 2026-09-19 is caught", () => {
  // The real [limitations] scene carried the resolution AND three
  // contingencies. One scene, two jobs.
  const script = soundScript();
  script.scenes[4] = scene("[limitations] Uneven stakes", words(150));
  const result = validateScriptStructure(script);
  assert.ok(result.violations.some((v) => v.rule === "scene_word_cap" && /150 words/.test(v.detail)));
});

test("a first reply arriving past the ceiling is caught", () => {
  // The @15 draft put the first usable reply at word 82 of a 90-word ceiling;
  // push the opening wider and it breaches.
  const script = soundScript();
  script.scenes[0] = scene("[scenario] An idea loses its author", words(80));
  const result = validateScriptStructure(script);
  const violation = result.violations.find((v) => v.rule === "first_reply_too_late");
  assert.ok(violation, "expected first_reply_too_late");
  assert.match(violation!.detail, new RegExp(`ceiling ${FIRST_REPLY_WORD_CEILING}`));
});

test("stacked explanation scenes are caught", () => {
  const script = soundScript();
  script.scenes.splice(4, 0, scene("[explanation] More explaining", words(30)));
  const result = validateScriptStructure(script);
  assert.ok(result.violations.some((v) => v.rule === "stacked_explanation"));
});

test("a payoff tag moved onto a recap is caught even when the word budget passes", () => {
  // This is the exact 2026-09-19 gaming case: the decisive exchange sits in an
  // earlier scene, [payoff] holds a dialogue-free summary, and every numeric
  // rule is satisfied. A check that trusted the tag would pass this.
  const script = {
    scenes: [
      scene("[scenario] An idea loses its author", `${words(15)} "That was my plan."`),
      scene("[response_a] Becomes a dispute", `${words(20)} "Actually, that was mine."`),
      scene("[response_b] Name the work", `${words(20)} "I drafted the pilot."`),
      scene("[explanation] Separate contributions", words(30)),
      // The real resolution, mislabelled.
      scene("[limitations] Speak despite the stakes", `${words(30)} "I designed the test." The director nods.`),
      scene("[exercise] Rehearse one sentence", words(30)),
      // A dialogue-free recap wearing the payoff tag.
      scene("[payoff] Claim work, not motives", `${words(20)} Which would you choose?`),
      scene("[bridge] When the boss takes credit", words(15), { is_outro: true }),
    ],
  };
  const result = validateScriptStructure(script);
  const suspect = result.violations.find((v) => v.rule === "payoff_tag_suspect");
  assert.ok(suspect, `expected payoff_tag_suspect, got ${result.violations.map((v) => v.rule).join(", ")}`);
  assert.match(suspect!.detail, /may be on a recap/);
  // And the numeric post-payoff rules are indeed satisfied, which is the point.
  assert.ok(!result.violations.some((v) => v.rule === "post_payoff_word_cap"));
});

test("a payoff landing before the last third is caught", () => {
  const script = soundScript();
  // Push a lot of material after the payoff so it resolves early.
  script.scenes.splice(7, 0, scene("[explanation] Long aftermath", words(80)));
  const result = validateScriptStructure(script);
  assert.ok(result.violations.some((v) => v.rule === "payoff_too_early"));
  assert.ok(result.violations.some((v) => v.rule === "post_payoff_word_cap"));
});

test("a question in the outro bridge is caught", () => {
  // Exactly what growth_packager@9 shipped: a second closing question.
  const script = soundScript();
  script.scenes[7] = scene("[bridge]", "What if your boss is the one stealing your ideas?", { is_outro: true });
  const result = validateScriptStructure(script);
  assert.ok(result.violations.some((v) => v.rule === "outro_is_question"));
  // The outro question must not also be counted as a second discussion
  // invitation -- that would report one fault twice.
  assert.ok(!result.violations.some((v) => v.rule === "multiple_questions"));
});

test("the opening address plus one discussion question is the allowed pair", () => {
  // Two is now correct, not a violation: the episode opens by addressing the
  // listener and closes by inviting them to answer.
  const result = validateScriptStructure(soundScript());
  assert.ok(!result.violations.some((v) => v.rule === "multiple_questions"));
  assert.ok(!result.violations.some((v) => v.rule === "no_discussion_question"));
});

test("a third narrator question is the advert register and is caught", () => {
  const script = soundScript();
  script.scenes[5] = scene("[exercise] Rehearse", `${words(20)} Would you say it aloud?`);
  const result = validateScriptStructure(script);
  const violation = result.violations.find((v) => v.rule === "multiple_questions");
  assert.ok(violation, "three narrator questions must be caught");
  assert.match(violation!.detail, /allowed 2/);
});

test("an opening that never addresses the listener is caught", () => {
  const script = soundScript();
  script.scenes[0] = scene("[scenario] An idea loses its author", `${words(20)} "That was my plan."`);
  const result = validateScriptStructure(script);
  const rules = new Set(result.violations.map((v) => v.rule));
  assert.ok(rules.has("no_direct_address"));
  assert.ok(rules.has("no_opening_question"));
});

test("addressing the listener once and then performing at them is caught", () => {
  // The hook reads personal, the rest of the episode does not. Second-person
  // words inside dialogue do not rescue it -- a character saying "you" to
  // another character is not the narrator addressing the viewer.
  const script = {
    scenes: [
      scene("[scenario] Hear your plan become theirs", "Do you ever hear your own plan described as someone else's?"),
      scene("[response_a] It becomes a dispute", `${words(20)} "Actually, that was your idea?" she asks.`),
      scene("[response_b] Name the work", `${words(20)} "I drafted the pilot."`),
      scene("[explanation] Separate contributions", words(20)),
      scene("[limitations] Uneven stakes", words(20)),
      scene("[exercise] Rehearse once", words(20)),
      scene("[payoff] Answer for the design", `${words(20)} "Why two days?" Which would it be?`),
      scene("[bridge] When the boss takes credit", words(12), { is_outro: true }),
    ],
  };
  const result = validateScriptStructure(script);
  assert.ok(result.violations.some((v) => v.rule === "address_dropped_after_hook"));
});

test("telling the listener what they are is caught; naming their situation is not", () => {
  // The distinction the whole section rests on. A synthetic narrator
  // diagnosing an anxious listener is the failure mode; describing a room
  // they recognise is the goal.
  for (const diagnosis of [
    "Do you lack confidence in a room full of people?",
    "If you're shy, this one is for you.",
    "You're the kind of person who freezes.",
    "You always go quiet when the room gets loud.",
    "You are naturally anxious in groups.",
  ]) {
    const script = soundScript();
    script.scenes[0] = scene("[scenario] An idea loses its author", diagnosis);
    const result = validateScriptStructure(script);
    assert.ok(
      result.violations.some((v) => v.rule === "character_diagnosis"),
      `expected a diagnosis violation for: ${diagnosis}`,
    );
  }

  for (const situation of [
    "Do you ever sit in a meeting and hear your own idea repeated back as someone else's?",
    "Has this happened to you: the table where everyone already seems to know each other?",
    "You know the moment when the room goes quiet and you have not said anything yet?",
  ]) {
    const script = soundScript();
    script.scenes[0] = scene("[scenario] An idea loses its author", situation);
    const result = validateScriptStructure(script);
    assert.ok(
      !result.violations.some((v) => v.rule === "character_diagnosis"),
      `situation-naming must be allowed: ${situation}`,
    );
  }
});

test("a character diagnosing another character in dialogue is drama, not a violation", () => {
  // "You always do this" said by one character to another is the episode
  // working. Only the narrator's own sentences are checked.
  const script = soundScript();
  script.scenes[1] = scene(
    "[response_a] The correction becomes a dispute",
    `${words(15)} "You always do this," she says. "You never let me finish."`,
  );
  const result = validateScriptStructure(script);
  assert.ok(!result.violations.some((v) => v.rule === "character_diagnosis"));
});

test("a question spoken by a character is not a second discussion invitation", () => {
  // The real @15 script had a character ask "Why two days?" AND a closing
  // discussion question. Counting both would flag a correct episode.
  const script = soundScript();
  script.scenes[1] = scene(
    "[response_a] Becomes a dispute",
    `${words(20)} "Actually, wasn't that mine?" she says. "Did nobody read my email?"`,
  );
  const result = validateScriptStructure(script);
  assert.ok(
    !result.violations.some((v) => v.rule === "multiple_questions"),
    `dialogue questions must not count: ${JSON.stringify(result.violations)}`,
  );
});

test("missing roles, a missing outro and an over-long label are each reported", () => {
  const script = {
    scenes: [
      scene("[scenario] " + "x".repeat(60), words(20)),
      scene("[payoff] Done", `${words(10)} "Yes." Which would you pick?`),
    ],
  };
  const result = validateScriptStructure(script);
  const rules = new Set(result.violations.map((v) => v.rule));
  assert.ok(rules.has("missing_role"));
  assert.ok(rules.has("no_outro"));
  assert.ok(rules.has("label_too_long"));
});

test("an empty or malformed payload fails closed rather than passing", () => {
  for (const payload of [null, {}, { scenes: "nope" }, { scenes: [] }]) {
    const result = validateScriptStructure(payload);
    assert.equal(result.ok, false);
    assert.ok(result.violations.length > 0);
  }
});

test("word positions are cumulative across scenes, not per scene", () => {
  const scenes = parseScenes(soundScript());
  assert.equal(scenes[0]!.wordsBefore, 0);
  assert.equal(scenes[1]!.wordsBefore, scenes[0]!.words);
  assert.equal(scenes[2]!.wordsBefore, scenes[0]!.words + scenes[1]!.words);
});

test("the summary counts scripts affected separately from total occurrences", () => {
  const twoLongScenes = soundScript();
  twoLongScenes.scenes[3] = scene("[explanation] A", words(SCENE_WORD_CAP + 10));
  twoLongScenes.scenes[4] = scene("[limitations] B", words(SCENE_WORD_CAP + 20));
  const oneLongScene = soundScript();
  oneLongScene.scenes[3] = scene("[explanation] A", words(SCENE_WORD_CAP + 5));

  const summary = summariseViolations([
    validateScriptStructure(twoLongScenes),
    validateScriptStructure(oneLongScene),
    validateScriptStructure(soundScript()),
  ]);
  const cap = summary.find((r) => r.rule === "scene_word_cap");
  assert.ok(cap);
  assert.equal(cap!.scripts, 2, "two of three scripts are affected");
  assert.equal(cap!.occurrences, 3, "but there are three offending scenes");
});
