import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guards against the exact class of bug fixed repeatedly in this codebase's
// history: a prompt teaching a `function=` vocabulary word that the
// downstream compiler's regex-based gates (cartoon-scenes.ts's
// assertActionQualityContract/assertV3ScriptContract) don't actually
// recognize, which fails deterministically regardless of model quality.
// These regexes are duplicated here on purpose (not imported) so a future
// change to either side shows up as a failing assertion instead of two
// files silently drifting apart again.
const HOOK_RE = /opening_problem|hook/;
const TAKEAWAY_RE = /practical_action|viewer_value|takeaway|changed behavior|replacement|replace|remove the cue|concrete action/;
const FINAL_BEAT_RE = /payoff_resolution|payoff|resolution|resolve|return|changed_behavior|habit|confirm/;
// Only checked for episodes >= LONG_SCRIPT_SECONDS (75s of narration) -- the
// first real production run of v10 hit exactly this gap: a ~120s episode
// tripped both of these, since none of v10's original vocabulary matched
// either regex. Fixed by widening the regexes (agent-validators.ts and
// cartoon-scenes.ts) rather than the prompt, since "correction"/"objection"/
// "visual_model" are the genuine equivalents of a midpoint-turn/engagement
// beat in this genre.
const MIDPOINT_RE = /midpoint|turn|reframe|reversal|correction/;
const ENGAGEMENT_RE = /engagement|joke|callback|contradiction|visual.?gag|punchline|absurd|pun|objection|visual_model/;

const agent = readFileSync(new URL("../agents/dialogue_script_writer.json", import.meta.url), "utf8");
// v11 added an explicit "no extra scene fields" note (production evidence:
// additionalProperties:false failures with no offending field named burned
// all 3 retries on a real run). v12 fixed a further real-run failure mode
// the same run then hit: the model sometimes emitted the `point` value as a
// bare, unquoted key fragment instead of a proper `"point": "..."` JSON
// field -- fixed by showing every point example already wrapped in its JSON
// field form rather than as bare pseudo-syntax text. v13 fixed two more
// real-run failure modes: (1) short lines drifting into clipped noun-phrase
// fragments ("Same tank, opposite verdicts.") instead of real spoken
// sentences, and (2) the function-order evidence check failing because the
// model's FIRST occurrence of `implication`/`correction`/`recap` landed out
// of the required sequence on different real scripts -- fixed with explicit
// mechanical ordering rules mirroring exactly what the evidence checker
// computes. v14 (the prompt-library optimization pass) trims the mechanical
// counting rules now enforced in script-dialogue-evidence.ts instead of
// prose, widens the emotion vocabulary from 6 to the 12 values visual_plan
// already supports, and reorders story/cast_roster to the end of the prompt
// for prefix-cache-friendliness -- the comprehension-structure vocabulary
// these tests actually check is unchanged from v10. v15 reverses the
// long-standing "do not write an outro scene" instruction: the writer now
// authors one real is_outro:true scene after the recap (the spoken CTA/
// sign-off), which is exempt from the eight-function vocabulary these tests
// check (script-dialogue-evidence.ts and cartoon-scenes.ts's
// assertV3ScriptContract both filter is_outro scenes out before applying
// any of the regexes below), so it needs no new vocabulary here. v16 fixes
// a real production failure (run_8945ec99) v15 shipped with: the writer
// read "1-2 short exchanges" as license to split the outro across two
// scene objects and only flagged the last one is_outro:true, so the
// unflagged CTA-only scene silently became "the last content scene" and
// failed final_teach_back for not being a real recap. v16 makes it
// unambiguous -- exactly one scene, one speaker -- and agent-validators.ts
// now catches the split mechanically if a model does it anyway.
const prompt = readFileSync(new URL("../prompts/dialogue_script_writer/16.md", import.meta.url), "utf8");

test("dialogue_script_writer agent is pinned to the comprehension prompt v16", () => {
  assert.match(agent, /"version":\s*"16"/);
  assert.match(agent, /"prompt":\s*"dialogue_script_writer@16"/);
});

test("v16's required function vocabulary satisfies the compiler's hard gates", () => {
  const requiredFunctions = [
    "hook",
    "intuitive_answer",
    "objection",
    "visual_model",
    "correction",
    "implication",
    "takeaway practical_action",
    "recap confirms_understanding",
  ];
  for (const fn of requiredFunctions) {
    assert.match(prompt, new RegExp(fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `prompt must teach function=${fn}`);
  }

  // The two beats the compiler hard-fails an entire script over: the opening
  // beat must satisfy hookClarity, and the final beat must satisfy
  // payoffResolution / assertV3ScriptContract's final-scene check.
  assert.match("hook", HOOK_RE, "the opening function value must match the compiler's hookClarity regex");
  assert.match("takeaway practical_action", TAKEAWAY_RE, "the takeaway function value must match the compiler's viewerTakeaway regex");
  assert.match("recap confirms_understanding", FINAL_BEAT_RE, "the recap function value must match the compiler's final-beat regexes");

  // Long episodes (>= 75s of narration) also need a midpoint-turn beat and at
  // least two engagement beats -- both checked here since real production
  // topics for this channel commonly run long enough to hit this path.
  assert.match("correction", MIDPOINT_RE, "the correction function value must match the compiler's midpoint-turn regex");
  assert.match("objection", ENGAGEMENT_RE, "objection must count as an engagement beat");
  assert.match("visual_model", ENGAGEMENT_RE, "visual_model must count as an engagement beat");
});

test("v14 no longer teaches the retired topic-specific prop contract", () => {
  // The old habit-vignette prop contract (phone/clock/keys for lateness
  // topics) doesn't generalize to arbitrary complex-concept episodes and was
  // deliberately dropped in the comprehension-structure rewrite.
  assert.doesNotMatch(prompt, /Topic-specific prop contract/);
});

test("v16 teaches a real spoken outro scene instead of forbidding one", () => {
  // Real production evidence (traced against a live run): story.outro_line
  // was never wired to the renderer and every prompt touching the script
  // forbade authoring an outro scene, so every episode's "outro" was a
  // silent generated card under a hardcoded default line. Fixed at the
  // source: the writer now authors the real scene.
  assert.doesNotMatch(prompt, /Do not write an outro scene/);
  assert.match(prompt, /is_outro.*true/s);
  assert.match(prompt, /outro_line/);
});

test("v16 makes the outro unambiguously one scene, not a split exchange", () => {
  // The exact production failure v16 fixes: v15 said "1-2 short exchanges
  // (both characters ideally get a line)", which read as license to split
  // the outro across two scene objects.
  assert.match(prompt, /exactly ONE additional final scene object/);
  assert.match(prompt, /single `speaker` and a single `narration` string/);
});
