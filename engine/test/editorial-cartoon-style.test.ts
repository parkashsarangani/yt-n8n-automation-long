import { test } from "node:test";
import assert from "node:assert/strict";

import { SCHEDULED_IMAGE_STYLE } from "../src/growth-scheduler.ts";
import { buildIllustratedPrompt } from "../src/workers/illustrated-scene-assets.ts";

test("scheduled production uses the expressive editorial-cartoon preset", () => {
  assert.equal(SCHEDULED_IMAGE_STYLE, "flat_comic_expressive");
});

test("expressive preset matches the channel's hand-drawn editorial reference identity", () => {
  const prompt = buildIllustratedPrompt(
    "a worried cafeteria worker looks up during a power outage",
    "flat_comic_expressive",
  );

  assert.match(prompt, /vintage editorial cartoon/i);
  assert.match(prompt, /rough black ink and charcoal contour lines/i);
  assert.match(prompt, /expressive caricatured human faces/i);
  assert.match(prompt, /flat muted navy\/slate\/brick-red\/ochre color blocks/i);
  assert.match(prompt, /cream off-white textured paper/i);
  assert.match(prompt, /subtle print grain/i);
  assert.match(prompt, /stick figures/i);
  assert.match(prompt, /faceless people/i);
  assert.match(prompt, /photorealism/i);
  assert.match(prompt, /glossy 3D/i);
});
