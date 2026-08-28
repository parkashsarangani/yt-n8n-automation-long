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
// v11 is v10 plus an explicit "no extra scene fields" note (production
// evidence: additionalProperties:false failures with no offending field
// named burned all 3 retries on a real run); the comprehension-structure
// vocabulary these tests actually check is unchanged from v10.
const prompt = readFileSync(new URL("../prompts/dialogue_script_writer/11.md", import.meta.url), "utf8");

test("dialogue_script_writer agent is pinned to the comprehension prompt v11", () => {
  assert.match(agent, /"version":\s*"11"/);
  assert.match(agent, /"prompt":\s*"dialogue_script_writer@11"/);
});

test("v11's required function vocabulary satisfies the compiler's hard gates", () => {
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

test("v11 no longer teaches the retired topic-specific prop contract", () => {
  // The old habit-vignette prop contract (phone/clock/keys for lateness
  // topics) doesn't generalize to arbitrary complex-concept episodes and was
  // deliberately dropped in the comprehension-structure rewrite.
  assert.doesNotMatch(prompt, /Topic-specific prop contract/);
});
