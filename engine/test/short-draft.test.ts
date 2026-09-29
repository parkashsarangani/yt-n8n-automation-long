/**
 * Studio "Write it for me" (2026-09-29): drafts a Short in the viral list
 * structure -- number promise + open loop in the hook, one item per paragraph,
 * a comment-bait close, 60-75 s -- with clickbait framing but no invented
 * statistics. The rules are checked deterministically and a failing draft is
 * sent back with the exact problems.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PromptStore } from "../src/prompts.ts";
import { draftShort, estimateSeconds, shortDraftProblems, type ShortDraft } from "../src/short-draft.ts";

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

test("the approved reference Short passes every rule and lands inside 60-75 s", () => {
  assert.deepEqual(shortDraftProblems(GOOD), []);
  const seconds = estimateSeconds(GOOD.hook, GOOD.script);
  assert.ok(seconds >= 60 && seconds <= 75, `${seconds}s`);
});

test("each viral-structure and honesty rule is enforced", () => {
  const cases: Array<[string, Partial<ShortDraft>, RegExp]> = [
    ["no number promise", { hook: "Your brain isn't lazy. It's scared. These psychology tricks make starting automatic, and the last one feels like cheating." }, /promise a number/],
    ["no open loop", { hook: "Your brain isn't lazy. It's scared. These three psychology tricks make starting almost automatic for anyone." }, /open loop/],
    ["invented statistic", { script: GOOD.script.replace("Suddenly your brain cares.", "It makes you 80% faster.") }, /percentage/],
    ["subscribe ask", { script: GOOD.script.replace("Tell me in the comments.", "Like and subscribe for more.") }, /like, subscribe or follow/],
    ["no closing question", { script: GOOD.script.replace("Which one are you trying first? Tell me in the comments.", "Try them all today.") }, /comment-bait question/],
    ["too long", { script: `${GOOD.script.split("\n\n").slice(0, 3).map((p) => `${p} ${p}`).join("\n\n")}\n\nWhich one first?` }, /spoken length/],
    ["dark psychology framing", { title: "Dark Psychology Tricks to Control Your Brain Today" }, /dark psychology/],
  ];
  for (const [label, change, expected] of cases) {
    const problems = shortDraftProblems({ ...GOOD, ...change });
    assert.ok(problems.some((p) => expected.test(p)), `${label}: ${JSON.stringify(problems)}`);
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

test("a draft that breaks a rule is sent back with the exact problems, then accepted", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const bad = { ...GOOD, script: GOOD.script.replace("Suddenly your brain cares.", "It makes you 80% faster.") };
  const fake = fakeProvider([bad, GOOD]);
  const result = await draftShort("why you procrastinate", { provider: fake.provider as never, prompts });
  assert.equal(fake.prompts.length, 2);
  assert.match(fake.prompts[0]!, /why you procrastinate/);
  assert.doesNotMatch(fake.prompts[0]!, /BROKE THESE RULES/);
  assert.match(fake.prompts[1]!, /BROKE THESE RULES[\s\S]*percentage/);
  assert.deepEqual(result.problems, []);
  assert.equal(result.attempts, 2);
  assert.equal(result.title, GOOD.title);
});

test("after three failed attempts the best draft comes back with its problems listed for the editor", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const bad = { ...GOOD, script: GOOD.script.replace("Suddenly your brain cares.", "It makes you 80% faster.") };
  const fake = fakeProvider([bad]);
  const result = await draftShort("why you procrastinate", { provider: fake.provider as never, prompts });
  assert.equal(fake.prompts.length, 3);
  assert.equal(result.attempts, 3);
  assert.ok(result.problems.some((p) => /percentage/.test(p)));
});

test("a missing or absurd topic is refused before any model call", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const fake = fakeProvider([GOOD]);
  await assert.rejects(draftShort("  ", { provider: fake.provider as never, prompts }), /topic must be/);
  assert.equal(fake.prompts.length, 0);
});
