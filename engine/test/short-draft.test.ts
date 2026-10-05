/**
 * Studio "Write it for me" (2026-09-29, revised after council review):
 * honesty and length are HARD rules (a breaking draft is rewritten), the
 * viral structure is SOFT (returned as warnings, no extra model call), and
 * three hook shapes keep every Short from being the same list formula.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PromptStore } from "../src/prompts.ts";
import { draftShort, estimateSeconds, shortDraftChecks, type ShortDraft } from "../src/short-draft.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The operator-approved reference Short, in v2 beat form (2026-10-02): the
 * same content as the original, split into short drawable beats with a
 * re-hook -- one beat per illustrated scene.
 */
const GOOD: ShortDraft = {
  title: "Your Brain Wants You to Procrastinate. Here's How to Beat It.",
  alternative_titles: ["3 Psychology Tricks That Make You Start Anything", "Why Do You Procrastinate on Things You Want?"],
  hook: "Your brain isn't lazy. It's scared. These three psychology tricks make starting almost automatic — and the third one feels like cheating.",
  script: [
    "You sit down to work. You open the laptop. Then your phone. Then the fridge. Twenty minutes gone, nothing started.",
    "Trick one: the two-minute start. Don't commit to finishing. Commit to two minutes. Open the file and write one ugly sentence.",
    "Your brain treats an unfinished task like an open tab. Psychologists call it the Zeigarnik effect. That open tab pulls you back in.",
    "But starting is only half the trap. The real enemy is the word tomorrow.",
    "Trick two: the if-then plan. Say this instead: if it's nine a.m. and my coffee is made, then I open the report.",
    "It's been tested in nearly a hundred studies, because the decision is already made before the moment arrives.",
    "And now the one that feels like cheating. On boring tasks, people work harder when someone can see them.",
    "Trick three: borrow an audience. Work in a café, sit on a video call with a friend, or promise to send it by five. Suddenly your brain cares.",
    "Which one are you trying first? Tell me in the comments.",
  ].join("\n\n"),
};

test("the approved reference Short passes every hard rule and every list suggestion, inside 60-75 s", () => {
  assert.deepEqual(shortDraftChecks(GOOD, "list"), { blocking: [], warnings: [] });
  const seconds = estimateSeconds(GOOD.hook, GOOD.script);
  assert.ok(seconds >= 60 && seconds <= 75, `${seconds}s`);
});

test("honesty and length are hard rules", () => {
  const cases: Array<[string, Partial<ShortDraft>, RegExp]> = [
    ["invented statistic", { script: GOOD.script.replace("Suddenly your brain cares.", "It makes you 80% faster.") }, /percentage/],
    ["subscribe ask", { script: GOOD.script.replace("Tell me in the comments.", "Like and subscribe for more.") }, /like, subscribe or follow/],
    ["dark psychology framing", { title: "Dark Psychology Tricks to Control Your Brain Today" }, /dark psychology/],
    ["too long", { script: GOOD.script.split("\n\n").map((p) => `${p} ${p}`).join("\n\n") }, /spoken length/],
  ];
  for (const [label, change, expected] of cases) {
    const { blocking } = shortDraftChecks({ ...GOOD, ...change });
    assert.ok(blocking.some((p) => expected.test(p)), `${label}: ${JSON.stringify(blocking)}`);
  }
});

test("v2 beats are a hard rule: a few long paragraphs (the v1 shape) or one giant beat is rewritten", () => {
  const v1Shape = GOOD.script.split("\n\n");
  const fewLong = [v1Shape.slice(0, 3).join(" "), v1Shape.slice(3, 6).join(" "), v1Shape.slice(6, 8).join(" "), v1Shape[8]!].join("\n\n");
  assert.ok(shortDraftChecks({ ...GOOD, script: fewLong }).blocking.some((p) => /6-9 short beats plus a closing line/.test(p)));
  const giant = [...v1Shape.slice(0, 6), `${v1Shape[6]} ${v1Shape[7]} Then you finally close the laptop and notice how easy it felt.`, v1Shape[8]!].join("\n\n");
  assert.ok(shortDraftChecks({ ...GOOD, script: giant }).blocking.some((p) => /beat 7 is \d+ words -- split it/.test(p)));
});

test("retention suggestions: a slow first sentence and long beats are flagged, never rewritten", () => {
  const slowHook = { ...GOOD, hook: "If you ever wondered why starting feels impossible, try these three tricks, and the third feels like cheating." };
  const s = shortDraftChecks(slowHook, "list");
  assert.deepEqual(s.blocking, []);
  assert.ok(s.warnings.some((w) => /first sentence is \d+ words -- 12 or fewer/.test(w)));
  // Same words, one beat fewer: beat 1 absorbs beat 4 and runs long.
  const beats = GOOD.script.split("\n\n");
  beats[0] = `${beats[0]} ${beats[3]}`;
  beats.splice(3, 1);
  const l = shortDraftChecks({ ...GOOD, script: beats.join("\n\n") }, "list");
  assert.deepEqual(l.blocking, []);
  assert.ok(l.warnings.some((w) => /beat 1 run past 30 words/.test(w)), JSON.stringify(l.warnings));
});

test("the v2 prompt asks for views and watch time: drawable beats, re-hooks, escalation, a loop ending", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const text = prompts.render("short_script_writer@2", { topic: "t", shape_rules: "s", feedback: "" });
  for (const needle of [/views and watch time/, /6-9 beats/, /RE-HOOK/, /ESCALATE/, /LOOPS back to the hook/, /could be drawn/]) assert.match(text, needle);
});

test("the viral structure is only a suggestion: warnings, never a rewrite", () => {
  const cases: Array<[string, Partial<ShortDraft>, RegExp]> = [
    ["no number promise", { hook: "Your brain isn't lazy. It's scared. These psychology tricks make starting automatic, and the last one feels like cheating." }, /promises a number/],
    ["no open loop", { hook: "Your brain isn't lazy. It's scared. These three psychology tricks make starting almost automatic for anyone." }, /teases the last item/],
    ["no closing question", { script: GOOD.script.replace("Which one are you trying first? Tell me in the comments.", "Try them all today and see.") }, /question/],
  ];
  for (const [label, change, expected] of cases) {
    const { blocking, warnings } = shortDraftChecks({ ...GOOD, ...change }, "list");
    assert.deepEqual(blocking, [], `${label} must not block`);
    assert.ok(warnings.some((w) => expected.test(w)), `${label}: ${JSON.stringify(warnings)}`);
  }
});

test("a myth-bust or everyday-moment hook is not held to the list formula", () => {
  const myth = { ...GOOD, hook: "You've been told procrastination is laziness. It isn't. Here's what's really happening in your brain." };
  for (const shape of ["myth", "moment"] as const) {
    const { blocking, warnings } = shortDraftChecks(myth, shape);
    assert.deepEqual(blocking, []);
    assert.ok(!warnings.some((w) => /number|last item/.test(w)), `${shape}: ${JSON.stringify(warnings)}`);
  }
});

function fakeProvider(responses: ShortDraft[]) {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      id: "fake/model",
      capabilities: () => ({ structuredOutput: "native" as const, maxOutputTokens: 8000 }),
      complete: async (req: { prompt: string }) => {
        prompts.push(req.prompt);
        return { value: responses[Math.min(prompts.length - 1, responses.length - 1)], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "fake", model: "fake" }, providerRef: "fake/model" };
      },
    },
  };
}

test("a hard-rule failure is sent back with the exact problems, then accepted", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const bad = { ...GOOD, script: GOOD.script.replace("Suddenly your brain cares.", "It makes you 80% faster.") };
  const fake = fakeProvider([bad, GOOD]);
  const result = await draftShort("why you procrastinate", { provider: fake.provider as never, prompts });
  assert.equal(fake.prompts.length, 2);
  assert.match(fake.prompts[0]!, /why you procrastinate/);
  assert.match(fake.prompts[0]!, /LIST SHORT/);
  assert.doesNotMatch(fake.prompts[0]!, /BROKE THESE RULES/);
  assert.match(fake.prompts[1]!, /BROKE THESE RULES[\s\S]*percentage/);
  assert.deepEqual(result.problems, []);
  assert.equal(result.attempts, 2);
  assert.equal(result.shape, "list");
});

test("a structure-only miss costs no extra model call; the editor just sees the suggestion", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const noLoop = { ...GOOD, hook: "Your brain isn't lazy. It's scared. These three psychology tricks make starting almost automatic for anyone." };
  const fake = fakeProvider([noLoop]);
  const result = await draftShort("why you procrastinate", { provider: fake.provider as never, prompts });
  assert.equal(fake.prompts.length, 1);
  assert.deepEqual(result.problems, []);
  assert.ok(result.warnings.some((w) => /teases the last item/.test(w)));
});

test("the chosen hook shape reaches the prompt; an unknown one is refused before any model call", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const fake = fakeProvider([GOOD]);
  await draftShort("replaying awkward moments at night", { provider: fake.provider as never, prompts }, "moment");
  assert.match(fake.prompts[0]!, /EVERYDAY-MOMENT SHORT/);
  assert.doesNotMatch(fake.prompts[0]!, /LIST SHORT/);
  const none = fakeProvider([GOOD]);
  await assert.rejects(draftShort("topic", { provider: none.provider as never, prompts }, "rant" as never), /shape must be/);
  await assert.rejects(draftShort("  ", { provider: none.provider as never, prompts }), /topic must be/);
  assert.equal(none.prompts.length, 0);
});

test("second person only (operator: people don't care unless it's about them): an 'Emma' story is rewritten", () => {
  const emma = {
    ...GOOD,
    hook: "Emma's brain isn't lazy. It's scared. Three tricks made starting almost automatic for her — the third one felt like cheating.",
    script: GOOD.script
      .replace(/\bYou sit down\b/g, "Emma sits down").replace(/\byour\b/gi, "her").replace(/\byou\b/gi, "she"),
  };
  const { blocking } = shortDraftChecks(emma, "list");
  assert.ok(blocking.some((p) => /second person/.test(p)), JSON.stringify(blocking));
  const named = { ...GOOD, hook: `A woman named Clara froze in a meeting. ${GOOD.hook}` };
  assert.ok(shortDraftChecks(named, "list").blocking.some((p) => /second person/.test(p)), "a 'named X' character is a story about someone else");
  assert.ok(!shortDraftChecks(GOOD, "list").blocking.some((p) => /second person/.test(p)), "the approved 'you' Short passes");
});

test("the v3 prompt tells the writer: second person only, no named characters", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const text = prompts.render("short_script_writer@3", { topic: "t", shape_rules: "s", feedback: "" });
  assert.match(text, /SECOND PERSON ONLY/);
  assert.match(text, /no named characters/);
});
