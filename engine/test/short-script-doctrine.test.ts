/**
 * Shorts script doctrine (operator 2026-10-12, sharpened 2026-10-21): the
 * viewer is "you" from the first line to the last and feels the issue happen
 * to them; the opening relates the topic to the viewer; full drama, creative,
 * with a real mechanism and a real philosopher -- and no stage or gate allowed
 * to flatten it. The 2026-10-12 fixed role order and announced "contract" are
 * gone: they turned every Short into a syllabus. Length is a guide; it only has
 * to publish as a Short/Reel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDefs, promptForFormat, validateCatalog } from "../src/catalog.ts";
import { agentSemanticValidationErrors } from "../src/agent-validators.ts";
import { PromptStore } from "../src/prompts.ts";
import { SHORT_MAX_WORDS, shortScriptErrors, socialSeriesScriptErrors } from "../src/social-series.ts";
import type { AgentDef } from "../src/runner.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const scene = (scene_index: number, point: string, narration: string, is_outro = false) => ({ scene_index, point, narration, ...(is_outro ? { is_outro } : {}) });
const GOOD = {
  scenes: [
    scene(0, "[hook] Your phone lights up", "Your phone lights up: 'Can we talk later?' And your stomach drops."),
    scene(1, "[inner-voice] What did you do", "You scroll back through everything you said this week. 'They're annoyed with me.' You're sure of it."),
    scene(2, "[escalation] The evening is gone", "You don't eat properly. You rehearse an apology for something nobody mentioned. And the reason isn't the one you think."),
    scene(3, "[mechanism] Your brain fills the gap", "That's negativity bias: when your mind gets no information, it fills the silence with the worst story it has."),
    scene(4, "[twist] Seneca on imagined trouble", "Seneca saw it two thousand years ago: you suffer more in imagination than in reality. You're serving a sentence nobody passed."),
    scene(5, "[payoff] The text was about a sofa", "Later the message comes: they wanted help moving a sofa. You lost a whole evening to a verdict you wrote yourself."),
    scene(6, "[outro] Silence is not a verdict", "Silence isn't a verdict. Stop serving the sentence.", true),
  ],
};

test("a Short that relates first, stays on 'you', names a thinker and ends on a verdict passes -- in any beat order", () => {
  assert.deepEqual(shortScriptErrors(GOOD), []);
  const reordered = structuredClone(GOOD);
  [reordered.scenes[3], reordered.scenes[4]] = [reordered.scenes[4]!, reordered.scenes[3]!];
  assert.deepEqual(shortScriptErrors(reordered), [], "the writer orders the beats for drama; no fixed role order is enforced");
});

test("the old lesson structure is not demanded of a Short -- and a lesson script fails the Short rules", () => {
  const lesson = { scenes: ["scenario", "response_a", "response_b", "explanation", "limitations", "exercise", "payoff"].map((r, i) => scene(i, `[${r}] beat`, "You do something here in the story.")).concat(scene(7, "[outro] next", "Next time, one more thing.", true)) };
  assert.deepEqual(socialSeriesScriptErrors(lesson), [], "fixture is a valid long-form lesson");
  const errors = shortScriptErrors(lesson);
  assert.ok(errors.some((e) => /\[hook\]/.test(e)) && errors.some((e) => /philosopher/.test(e)));
  assert.ok(!shortScriptErrors(GOOD).some((e) => /limitations|exercise|contract|promise/.test(e)), "no caveat, homework scene or announced contract is ever required");
});

test("Short gates: 'you' from the first scene to the last, no third-person protagonist, a real thinker, fits a Short/Reel", () => {
  const coldOpen = structuredClone(GOOD);
  coldOpen.scenes[0]!.narration = "Negativity bias is the brain's tendency to weigh bad news more.";
  assert.ok(shortScriptErrors(coldOpen).some((e) => /relates the topic to the viewer/.test(e)));

  const drift = structuredClone(GOOD);
  drift.scenes[3]!.narration = "That's negativity bias: the mind fills silence with the worst story it has.";
  assert.ok(shortScriptErrors(drift).some((e) => /keep "you" throughout: scene\(s\) 3/.test(e)));

  const story = structuredClone(GOOD);
  story.scenes[1]!.narration = "She scrolls back through the week. He is annoyed with her, she decides. Her evening is gone, and you watch it.";
  assert.ok(shortScriptErrors(story).some((e) => /somebody else's story/.test(e)));
  const friend = structuredClone(GOOD);
  friend.scenes[5]!.narration = "Later your friend texts: she wanted help moving a sofa. You lost the evening to a verdict you wrote.";
  assert.deepEqual(shortScriptErrors(friend), [], "others may appear in relation to you");

  const noThinker = structuredClone(GOOD);
  noThinker.scenes[4]!.narration = "Old wisdom saw it first: you suffer more in imagination than in reality.";
  assert.ok(shortScriptErrors(noThinker).some((e) => /name the real philosopher/.test(e)));

  const long = structuredClone(GOOD);
  long.scenes[2]!.narration = "And it costs you more. ".repeat(Math.ceil(SHORT_MAX_WORDS / 5));
  assert.ok(shortScriptErrors(long).some((e) => /no longer fits a Short\/Reel/.test(e)));
  const longerButFine = structuredClone(GOOD);
  longerButFine.scenes[2]!.narration = "And it costs you more than the evening, every time you choose it. ".repeat(12);
  assert.ok(!shortScriptErrors(longerButFine).some((e) => /fits a Short/.test(e)), "length is a guide: a longer complete message is not an error");

  const imagine = structuredClone(GOOD);
  imagine.scenes[0]!.narration = "Imagine you get a text that says we need to talk.";
  assert.ok(shortScriptErrors(imagine).some((e) => /'Imagine'/.test(e)));
});

test("the writer's gate follows the format: Short rules for Shorts, lesson rules for long-form", () => {
  const def = { name: "narration_script_writer" } as AgentDef;
  const inputs = { intent: { payload: { niche: "everyday-psychology" } } } as never;
  const previous = process.env["VIDEO_FORMAT"];
  try {
    process.env["VIDEO_FORMAT"] = "short";
    assert.deepEqual(agentSemanticValidationErrors(def, GOOD, inputs), []);
    process.env["VIDEO_FORMAT"] = "long";
    assert.ok(agentSemanticValidationErrors(def, GOOD, inputs).some((e) => /\[scenario\]/.test(e)));
  } finally {
    if (previous === undefined) delete process.env["VIDEO_FORMAT"]; else process.env["VIDEO_FORMAT"] = previous;
  }
});

test("Shorts load their own prompts; long-form keeps the old ones; a missing format prompt fails the boot check", async () => {
  const shorts = await loadAgentDefs(path.join(ROOT, "agents"), "short");
  const longs = await loadAgentDefs(path.join(ROOT, "agents"), "long");
  const expected: Record<string, [string, string]> = {
    discovery: ["discovery@7", "discovery@6"],
    growth_packager: ["growth_packager@14", "growth_packager@12"],
    narrative_story_architect: ["narrative_story_architect@10", "narrative_story_architect@8"],
    narration_script_writer: ["narration_script_writer@21", "narration_script_writer@19"],
    watchability_critic: ["watchability_critic@14", "watchability_critic@12"],
  };
  for (const [name, [short, long]] of Object.entries(expected)) {
    assert.equal(shorts.get(name)!.prompt, short);
    assert.equal(longs.get(name)!.prompt, long);
  }
  assert.equal(promptForFormat({ prompt: "a@1" } as AgentDef, "short"), "a@1", "no per-format prompt: the default");
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  assert.doesNotThrow(() => validateCatalog(shorts, { hasSchema: () => true, hasPrompt: (r) => prompts.has(r) }));
  const broken = new Map([["x", { ...shorts.get("narration_script_writer")!, prompt_by_format: { short: "narration_script_writer@99" } }]]);
  assert.throws(() => validateCatalog(broken, { hasSchema: () => true, hasPrompt: (r) => prompts.has(r) }), /narration_script_writer@99/);
});

test("every Shorts prompt renders with exactly its stage's inputs, carries the doctrine, and demands nothing that flattens", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const cases: Array<[string, Record<string, string>]> = [
    ["discovery@7", { history: "[]", insights: "{}" }],
    ["growth_packager@14", { intent: "{}", insights: "{}" }],
    ["narrative_story_architect@10", { intent: "{}", growth: "{}", insights: "{}" }],
    ["narration_script_writer@21", { story: "{}", growth: "{}", intent: "{}", revision: "null" }],
    ["watchability_critic@14", { growth: "{}", intent: "{}", story: "{}", script: "{}" }],
  ];
  for (const [ref, vars] of cases) {
    const text = prompts.render(ref, vars);
    assert.match(text, /philosoph/i, `${ref}: psychology + philosophy`);
    assert.match(text, /expert/i, `${ref}: expert voice`);
    assert.match(text, /happening to (YOU|them)/, `${ref}: the viewer lives the issue`);
    assert.match(text, /that's (literally )?me/i, `${ref}: the opening relates the topic to the viewer`);
    assert.match(text, /no named characters|never a named character/i, `${ref}: no third-person story`);
    assert.match(text, /twist/i, `${ref}: drama`);
    assert.match(text, /invented (studies|statistics)|zero invented facts/i, `${ref}: truth is the one brake`);
    assert.doesNotMatch(text, /expectation contract[^ ]* (?!format)|countable|low-pressure|a limitation acknowledged|Is a limitation|thoughtful editorial guide|proportionate outcome|no inflated threat/i, `${ref}: no announced syllabus, no flattening requirement`);
  }
  // The studio's "Write it for me" drafts keep their own (already second-person) prompt.
  assert.match(prompts.render("short_script_writer@4", { topic: "t", shape_rules: "s", feedback: "" }), /philosoph/i);
});

test("the spoken last line (next_video_bridge) must be a statement, never a question or teaser", async () => {
  const { continuationBridgeErrors } = await import("../src/agent-validators.ts");
  assert.ok(continuationBridgeErrors({ next_video_bridge: "What if you could turn procrastination into a productivity tool?" }).some((e) => /declarative/.test(e)));
  assert.ok(continuationBridgeErrors({ next_video_bridge: "Ever wondered why the deadline feels like relief" }).some((e) => /declarative/.test(e)));
  assert.deepEqual(continuationBridgeErrors({ next_video_bridge: "Fear doesn't have to leave. It just loses the deciding vote." }), []);
});

test("the last line is a verdict, never a progress recap", async () => {
  const { continuationBridgeErrors } = await import("../src/agent-validators.ts");
  assert.ok(continuationBridgeErrors({ next_video_bridge: "You've taken the first step towards breaking the cycle of rumination." }).length > 0);
  assert.ok(continuationBridgeErrors({ next_video_bridge: "Now you know why the memory keeps coming back." }).length > 0);
  assert.deepEqual(continuationBridgeErrors({ next_video_bridge: "You owe that joke no more nights." }), []);
});

test("a Short ends on the writer's own verdict: release keeps it; long-form still uses the bridge; a recap or question verdict fails the gate", async () => {
  const { enforceContinuationBridge } = await import("../src/workers/watchability-release.ts");
  const script = { scenes: [scene(0, "[payoff] x", "You type your name."), scene(1, "[outro] verdict", "Starting is how you stop waiting.", true)] };
  const pkg = { next_video_bridge: "You are now one step closer to facing your tasks." };
  const previous = process.env["VIDEO_FORMAT"];
  try {
    process.env["VIDEO_FORMAT"] = "short";
    assert.equal((enforceContinuationBridge(script, pkg) as typeof script).scenes[1]!.narration, "Starting is how you stop waiting.");
    process.env["VIDEO_FORMAT"] = "long";
    assert.equal((enforceContinuationBridge(script, pkg) as typeof script).scenes[1]!.narration, pkg.next_video_bridge);
  } finally {
    if (previous === undefined) delete process.env["VIDEO_FORMAT"]; else process.env["VIDEO_FORMAT"] = previous;
  }
  const recap = structuredClone(GOOD);
  recap.scenes[6]!.narration = "You are now one step closer to facing your tasks without fear.";
  assert.ok(shortScriptErrors(recap).some((e) => /progress recap/.test(e)));
  const teaser = structuredClone(GOOD);
  teaser.scenes[6]!.narration = "What if you could turn this into a productivity tool?";
  assert.ok(shortScriptErrors(teaser).some((e) => /never a question/.test(e)));
});
