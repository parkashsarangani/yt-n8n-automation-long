/**
 * Shorts script doctrine (operator 2026-10-12): philosophy behind the
 * psychology, an expert speaking to "you", a hook the viewer recognises as
 * their own life, expectations built and then delivered precisely -- and no
 * stage or gate allowed to flatten it. Length is a guide, not a cap; it only
 * has to publish as a Short/Reel.
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
    scene(0, "[hook] You stay to get your money's worth", "You stay at the concert you hate because the ticket cost two hundred."),
    scene(1, "[promise] Why, who saw it, the question", "It costs you more than the ticket. Here's why you do it, what Seneca saw, and the one question that ends it."),
    scene(2, "[mechanism] Your brain protects the money", "Here's why. Your mind treats money already spent as something you can still save, so you keep paying with your evening."),
    scene(3, "[philosophy] Seneca on spent time", "Seneca saw it first: you guard your money and squander your time, the one thing you can never earn back."),
    scene(4, "[escalation] It is never just the ticket", "And it is never just the ticket. It is the job you stay in, the plan you keep, the years you keep paying."),
    scene(5, "[payoff] The from-scratch question", "So ask the question that ends it: if you had not paid, would you choose this now? If not, you stand up."),
    scene(6, "[outro] Your time is the price", "The money is gone either way. Your time is the only thing still on the table.", true),
  ],
};

test("a Short with the six roles, an early contract, a named thinker and 'you' throughout passes", () => {
  assert.deepEqual(shortScriptErrors(GOOD), []);
});

test("the old lesson structure is not demanded of a Short -- and a lesson script fails the Short rules", () => {
  const lesson = { scenes: ["scenario", "response_a", "response_b", "explanation", "limitations", "exercise", "payoff"].map((r, i) => scene(i, `[${r}] beat`, "You do something here in the story.")).concat(scene(7, "[outro] next", "Next time, one more thing.", true)) };
  assert.deepEqual(socialSeriesScriptErrors(lesson), [], "fixture is a valid long-form lesson");
  const errors = shortScriptErrors(lesson);
  assert.ok(errors.some((e) => /\[hook\]/.test(e)) && errors.some((e) => /\[philosophy\]/.test(e)));
  assert.ok(!shortScriptErrors(GOOD).some((e) => /limitations|exercise/.test(e)), "no caveat or homework scene is ever required");
});

test("Short gates: contract early, delivered after it, a real thinker named, payoff last, about 'you', fits a Short/Reel", () => {
  const late = structuredClone(GOOD);
  late.scenes[0]!.narration = "You stay. ".repeat(30);
  assert.ok(shortScriptErrors(late).some((e) => /expectation contract starts after word/.test(e)));

  const noThinker = structuredClone(GOOD);
  noThinker.scenes[3]!.narration = "Old wisdom saw it first: you guard money and squander time.";
  assert.ok(shortScriptErrors(noThinker).some((e) => /name the real philosopher/.test(e)));

  const payoffEarly = structuredClone(GOOD);
  [payoffEarly.scenes[4], payoffEarly.scenes[5]] = [payoffEarly.scenes[5]!, payoffEarly.scenes[4]!];
  assert.ok(shortScriptErrors(payoffEarly).some((e) => /\[payoff\] is the last substantive scene/.test(e)));

  const story = structuredClone(GOOD);
  for (const s of story.scenes) s.narration = s.narration.replace(/\byou(r)?\b/gi, "she");
  assert.ok(shortScriptErrors(story).some((e) => /speak to the viewer/.test(e)));

  const long = structuredClone(GOOD);
  long.scenes[4]!.narration = "And it costs more. ".repeat(Math.ceil(SHORT_MAX_WORDS / 4));
  assert.ok(shortScriptErrors(long).some((e) => /no longer fits a Short\/Reel/.test(e)));
  const longerButFine = structuredClone(GOOD);
  longerButFine.scenes[4]!.narration = "And it costs more than the ticket, every time you choose it. ".repeat(12);
  assert.ok(!shortScriptErrors(longerButFine).some((e) => /fits a Short/.test(e)), "length is a guide: a longer complete message is not an error");

  const imagine = structuredClone(GOOD);
  imagine.scenes[0]!.narration = "Imagine you stay at a concert you hate.";
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
    growth_packager: ["growth_packager@13", "growth_packager@12"],
    narrative_story_architect: ["narrative_story_architect@9", "narrative_story_architect@8"],
    narration_script_writer: ["narration_script_writer@20", "narration_script_writer@19"],
    watchability_critic: ["watchability_critic@13", "watchability_critic@12"],
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
    ["growth_packager@13", { intent: "{}", insights: "{}" }],
    ["narrative_story_architect@9", { intent: "{}", growth: "{}", insights: "{}" }],
    ["narration_script_writer@20", { story: "{}", growth: "{}", intent: "{}", revision: "null" }],
    ["watchability_critic@13", { growth: "{}", intent: "{}", story: "{}", script: "{}" }],
    ["short_script_writer@4", { topic: "t", shape_rules: "s", feedback: "" }],
  ];
  for (const [ref, vars] of cases) {
    const text = prompts.render(ref, vars);
    assert.match(text, /philosoph/i, `${ref}: psychology + philosophy`);
    assert.match(text, /expert/i, `${ref}: expert voice`);
    assert.match(text, /mirror|that's me/i, `${ref}: the recognition hook`);
    assert.match(text, /expectation contract/i, `${ref}: build expectations, deliver precisely`);
    assert.match(text, /invented (studies|statistics)|NO invented|zero invented facts|INVENTED FACTS ARE NOT/i, `${ref}: truth is the one brake`);
    assert.doesNotMatch(text, /low-pressure|a limitation acknowledged|Is a limitation|thoughtful editorial guide|proportionate outcome|no inflated threat/i, `${ref}: no flattening requirement`);
  }
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
