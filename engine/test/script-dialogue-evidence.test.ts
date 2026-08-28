import test from "node:test";
import assert from "node:assert/strict";

import { assessDialogueEvidence } from "../src/script-dialogue-evidence.ts";

const strongScript = {
  scenes: [
    { scene_index: 0, speaker: "host", emotion: "surprised", narration: "Why did the wider road slow us down?", point: "action=Host points at a traffic jam; prop=toy-cars; function=hook; value=wider roads created an unexpected result" },
    { scene_index: 1, speaker: "buddy", emotion: "happy", narration: "I think more lanes should clear it.", point: "action=Buddy adds an empty lane; prop=toy-cars; function=intuitive_answer; value=extra capacity appears to reduce congestion" },
    { scene_index: 2, speaker: "host", emotion: "surprised", narration: "Then why did more cars appear?", point: "action=Host points at arriving cars; prop=toy-cars; function=objection; value=the intuitive prediction conflicts with observation" },
    { scene_index: 3, speaker: "buddy", emotion: "neutral", narration: "Add space. Drivers switch routes.", point: "action=Buddy moves cars into the new lane; prop=toy-cars; function=visual_model; value=new capacity attracts previously hidden demand" },
    { scene_index: 4, speaker: "host", emotion: "surprised", narration: "So space changed people's choices.", point: "action=Host rearranges the same cars; prop=toy-cars; function=correction; value=capacity changes demand rather than only flow" },
    { scene_index: 5, speaker: "buddy", emotion: "neutral", narration: "And the empty lane fills again.", point: "action=Buddy fills the final gap; prop=toy-cars; function=implication; value=the congestion benefit can disappear" },
    { scene_index: 6, speaker: "host", emotion: "sad", narration: "Then widening alone buys temporary relief.", point: "action=Host removes the spare lane marker; prop=toy-cars; function=takeaway practical_action; value=decisions should account for changed behavior" },
    { scene_index: 7, speaker: "buddy", emotion: "happy", narration: "More room invited drivers, so traffic returned.", point: "action=Buddy replays the filled lanes; prop=toy-cars; function=recap confirms_understanding; value=the opening contradiction is now explainable" },
  ],
};

test("strong two-character explanation exposes every required evidence signal", () => {
  const result = assessDialogueEvidence(strongScript);
  assert.equal(result.passed, true, result.failures.join("\n"));
  assert.equal(result.coverage, 1);
  assert.equal(result.checks.length, 13);
});

test("alternating narration with flattering metadata cannot fake dialogue quality", () => {
  const result = assessDialogueEvidence({
    scenes: Array.from({ length: 8 }, (_, index) => ({
      scene_index: index,
      speaker: index < 7 ? "host" : "buddy",
      narration: "Here is another useful fact about this concept.",
      point: `action=Character talks; prop=none; function=${index === 0 ? "hook" : "implication"}; value=viewer learns concept`,
    })),
  });

  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("two_active_characters")));
  assert.ok(result.failures.some((failure) => failure.startsWith("comprehension_arc")));
  assert.ok(result.failures.some((failure) => failure.startsWith("physical_explanation_model")));
  assert.ok(result.failures.some((failure) => failure.startsWith("final_teach_back")));
});

test("close synonyms for the two compound terminal functions still count as the real beat", () => {
  // Production evidence: dialogue_script_writer wrote `function=payoff` for
  // its closing scene (echoing the `payoff` field already on its own `story`
  // input) instead of the taught `recap confirms_understanding`, and
  // `function=teach_back` on another run. The scene content itself was a
  // genuine, prop-reusing teach-back -- an exact-string lookup treating the
  // recap as entirely absent was a vocabulary false negative, not a real
  // content defect.
  const synonymScript = structuredClone(strongScript);
  synonymScript.scenes[6]!.point = synonymScript.scenes[6]!.point.replace("function=takeaway practical_action", "function=takeaway");
  synonymScript.scenes[7]!.point = synonymScript.scenes[7]!.point.replace("function=recap confirms_understanding", "function=payoff");

  const result = assessDialogueEvidence(synonymScript);
  assert.equal(result.passed, true, result.failures.join("\n"));
});

test("a compound recap prop still counts as reusing the visual model when it contains it", () => {
  // Production evidence: the recap staged the model prop alongside the
  // episode's opening object ("toy-cars" -> "toy-cars-and-original-jam"),
  // which is a stronger callback than repeating the bare prop name -- exact
  // equality treated that as an unrelated prop and failed a real reuse.
  const compoundRecap = structuredClone(strongScript);
  compoundRecap.scenes[7]!.point = compoundRecap.scenes[7]!.point.replace("prop=toy-cars;", "prop=toy-cars-and-original-jam;");

  const result = assessDialogueEvidence(compoundRecap);
  assert.equal(result.passed, true, result.failures.join("\n"));
});

test("an unrelated recap prop still fails model reuse", () => {
  const unrelatedRecap = structuredClone(strongScript);
  unrelatedRecap.scenes[7]!.point = unrelatedRecap.scenes[7]!.point.replace("prop=toy-cars;", "prop=whiteboard;");

  const result = assessDialogueEvidence(unrelatedRecap);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("model_reused_in_recap")));
});

test("a complete beat list still fails when characters do not predict, interact, or reuse the model", () => {
  const broken = structuredClone(strongScript);
  for (const scene of broken.scenes) {
    scene.speaker = "host";
    scene.narration = scene.narration.replace(/think|should|why|Then/gi, "");
  }
  broken.scenes[3]!.point = "action=Host explains the diagram; prop=diagram; function=visual_model; value=new capacity attracts previously hidden demand";
  broken.scenes[7]!.point = "action=Host closes the episode; prop=none; function=recap confirms_understanding; value=the opening contradiction is now explainable";

  const result = assessDialogueEvidence(broken);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("responsive_turn_taking")));
  assert.ok(result.failures.some((failure) => failure.startsWith("prediction_before_contradiction")));
  assert.ok(result.failures.some((failure) => failure.startsWith("model_reused_in_recap")));
  assert.ok(result.failures.some((failure) => failure.startsWith("both_characters_advance_reasoning")));
});


test("structurally correct dialogue still fails when delivery is emotionally flat", () => {
  const flat = structuredClone(strongScript);
  for (const scene of flat.scenes) scene.emotion = "neutral";

  const result = assessDialogueEvidence(flat);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("playable_emotional_palette")));
  assert.ok(result.failures.some((failure) => failure.startsWith("emotional_movement")));
  assert.ok(result.failures.some((failure) => failure.startsWith("model_break_reaction")));
});
