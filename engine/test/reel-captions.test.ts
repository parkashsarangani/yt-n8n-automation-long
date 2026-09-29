/**
 * Per-platform Reel captions (2026-09-29): short clickbait caption + hashtags
 * per platform, checked for honesty and length; a bad one falls back to the
 * title -- never the long YouTube description.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PromptStore } from "../src/prompts.ts";
import { captionProblems, fallbackCaption, reelCaptions } from "../src/reel-captions.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = {
  title: "Why You Replay Awkward Moments at Night",
  hook: "It's 11 p.m. You're replaying something you said at lunch.",
  script: "Your brain treats the moment like an unfinished task.\n\nWhen did this last happen to you?",
  seoTags: ["overthinking", "self talk"],
};

const GOOD = {
  facebook: { caption: "You replay it at 11 p.m. Here's why your brain won't let it go.", hashtags: ["psychology", "overthinking"] },
  instagram: {
    caption: "Your brain won't let you forget what you said at lunch.\nThe reason is not what you think.\nWhen did this last happen to you?",
    hashtags: ["psychology", "philosophy", "overthinking", "selfimprovement", "mindset", "anxiety"],
  },
};

function fake(value: unknown) {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      id: "fake/model",
      capabilities: () => ({ structuredOutput: "native" as const, maxOutputTokens: 8000 }),
      complete: async (req: { prompt: string }) => {
        prompts.push(req.prompt);
        if (value instanceof Error) throw value;
        return { value, usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "fake", model: "fake" }, providerRef: "fake/model" };
      },
    },
  };
}

test("each platform gets its own short caption with its own hashtags", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const f = fake(GOOD);
  const out = await reelCaptions(INPUT, { provider: f.provider as never, prompts });
  assert.match(f.prompts[0]!, /Why You Replay Awkward Moments/);
  assert.match(f.prompts[0]!, /replaying something you said at lunch/);
  assert.equal(out.facebook, "You replay it at 11 p.m. Here's why your brain won't let it go.\n\n#psychology #overthinking");
  assert.ok(out.instagram.startsWith("Your brain won't let you forget"));
  assert.match(out.instagram, /#psychology #philosophy #overthinking #selfimprovement #mindset #anxiety$/);
  assert.notEqual(out.facebook, out.instagram);
});

test("a caption breaking a rule is replaced by the title fallback, per platform", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const f = fake({ ...GOOD, facebook: { caption: "This trick works for 87% of people.", hashtags: ["psychology", "mind"] } });
  const out = await reelCaptions(INPUT, { provider: f.provider as never, prompts });
  assert.equal(out.facebook, fallbackCaption("facebook", INPUT.title, INPUT.seoTags));
  assert.ok(out.instagram.startsWith("Your brain won't let you forget"), "the good one is kept");
});

test("a model failure gives short title captions, never the description", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const out = await reelCaptions(INPUT, { provider: fake(new Error("quota")).provider as never, prompts });
  assert.equal(out.facebook, "Why You Replay Awkward Moments at Night\n\n#overthinking #psychology #philosophy");
  assert.equal(out.instagram, "Why You Replay Awkward Moments at Night\n\n#overthinking #selftalk #psychology #philosophy #selfimprovement #mindset #quietsignal");
});

test("honesty and length checks", () => {
  const tags = ["psychology", "mind"];
  assert.deepEqual(captionProblems("facebook", GOOD.facebook.caption, GOOD.facebook.hashtags), []);
  assert.match(captionProblems("facebook", "x".repeat(250), tags).join(), /10-200 characters/);
  assert.match(captionProblems("facebook", "Dark psychology tricks they hide", tags).join(), /dark psychology/);
  assert.match(captionProblems("facebook", "Subscribe for more of this daily", tags).join(), /subscribe/);
  assert.match(captionProblems("facebook", "Your brain does this #psychology", tags).join(), /hashtags belong/);
  assert.match(captionProblems("facebook", "Your brain does this every day", ["psychology"]).join(), /2-3 hashtags/);
  assert.match(captionProblems("instagram", `${"x".repeat(130)}\nmore`, GOOD.instagram.hashtags).join(), /first line/);
});
