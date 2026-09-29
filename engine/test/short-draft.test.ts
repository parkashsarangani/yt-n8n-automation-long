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

/** The hand-written reference Short the operator approved as the target style. */
const GOOD: ShortDraft = {
  title: "Your Brain Wants You to Procrastinate. Here's How to Beat It.",
  alternative_titles: ["3 Psychology Tricks That Make You Start Anything", "Why Do You Procrastinate on Things You Want?"],
  hook: "Your brain isn't lazy. It's scared. These three psychology tricks make starting almost automatic — and the third one feels like cheating.",
  script: [
    "Trick one: the two-minute start. Your brain treats an unfinished task like an open tab it can't close. Psychologists call it the Zeigarnik effect. So don't commit to finishing. Commit to two minutes. Open the file, write one ugly sentence, and let that open tab pull you back in.",
    "Trick two: the if-then plan. \"I'll do it tomorrow\" fails because your brain has nothing to react to. Say this instead: if it's nine a.m. and my coffee is made, then I open the report. It's been tested in nearly a hundred studies, because the decision is made before the moment arrives.",
    "Trick three feels like cheating: borrow an audience. On boring tasks, people work harder when someone can see them. It's called the audience effect. Work in a café, sit on a video call with a friend, or tell someone you'll send it by five. Suddenly your brain cares.",
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
    ["too long", { script: `${GOOD.script.split("\n\n").slice(0, 3).map((p) => `${p} ${p}`).join("\n\n")}\n\nWhich one first?` }, /spoken length/],
  ];
  for (const [label, change, expected] of cases) {
    const { blocking } = shortDraftChecks({ ...GOOD, ...change });
    assert.ok(blocking.some((p) => expected.test(p)), `${label}: ${JSON.stringify(blocking)}`);
  }
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
