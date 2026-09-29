/**
 * Operator decision 2026-09-28: every episode carries the channel CTA both
 * spoken (a final scene) and in the YouTube description -- exactly once.
 * Production before this: season episodes had no CTA at all, and custom
 * episodes had only the SEO model's "Thanks for watching — like and subscribe".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendSpokenCta, DESCRIPTION_CTA, SPOKEN_CTA, SPOKEN_CTA_SHORT, withDescriptionCta } from "../src/cta.ts";

const script = {
  scenes: [
    { scene_index: 0, act_index: 0, point: "[scenario] The message", narration: "You read a short reply." },
    { scene_index: 1, act_index: 2, point: "[bridge] Next time", narration: "Next, we'll see why you keep paying.", is_outro: true },
  ],
  word_count: 12,
};

test("the spoken CTA is its own final scene, after the next-episode teaser", () => {
  const out = appendSpokenCta(script) as typeof script & { scenes: Array<Record<string, unknown>> };
  assert.equal(out.scenes.length, 3);
  assert.deepEqual(out.scenes.slice(0, 2), script.scenes, "existing scenes are untouched");
  const cta = out.scenes[2]!;
  assert.equal(cta.narration, SPOKEN_CTA);
  assert.equal(cta.scene_index, 2);
  assert.equal(cta.act_index, 2);
  assert.equal(cta.is_outro, undefined, "the teaser stays the single outro scene");
  assert.ok(out.word_count > script.word_count);
});

test("the spoken CTA is never added twice", () => {
  const once = appendSpokenCta(script);
  assert.deepEqual(appendSpokenCta(once), once);
});

test("the description ends with exactly one CTA: ours", () => {
  assert.equal(withDescriptionCta("A story about a message."), `A story about a message.\n\n${DESCRIPTION_CTA}`);
  // The SEO model's own ask -- on its own line or glued to the last paragraph -- is replaced, not doubled.
  assert.equal(
    withDescriptionCta("A story about a message.\n\nThanks for watching — like and subscribe for more."),
    `A story about a message.\n\n${DESCRIPTION_CTA}`,
  );
  assert.equal(
    withDescriptionCta("A story about a message. Thanks for watching — like and subscribe for more."),
    `A story about a message.\n\n${DESCRIPTION_CTA}`,
  );
  // "Subscribe" in the middle of real content is not a CTA and stays.
  const content = "Why we subscribe to services we never use.\n\nThe sunk cost trap, explained.";
  assert.equal(withDescriptionCta(content), `${content}\n\n${DESCRIPTION_CTA}`);
});

test("a Short closes on the ~2 s line, long-form on the full CTA", () => {
  const short = appendSpokenCta(script, "short") as { scenes: Array<{ narration: string }> };
  assert.equal(short.scenes.at(-1)!.narration, SPOKEN_CTA_SHORT);
  assert.ok(SPOKEN_CTA_SHORT.split(/\s+/).length <= 8, "must stay under about three seconds spoken");
  assert.match(SPOKEN_CTA_SHORT, /Quiet Signal/);
  const long = appendSpokenCta(script, "long") as { scenes: Array<{ narration: string }> };
  assert.equal(long.scenes.at(-1)!.narration, SPOKEN_CTA);
});
