/**
 * manual-script.ts turns operator-typed text straight into story/script
 * artifacts with no model in the loop, so the only thing worth testing is
 * whether the mechanical output actually satisfies the schemas every
 * downstream agent and worker already trusts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "../src/registry.ts";
import { buildManualEpisode } from "../src/manual-script.ts";
import { validateGrowthPackageSelection, validateGrowthPackageReleaseability } from "../src/growth-package-contract.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function registry() {
  return SchemaRegistry.load(path.join(ROOT, "schemas"));
}

const HOOK = "Chile is over 2,600 miles long, but almost nobody agrees on why it stayed that shape.";

const PARAGRAPHED_NARRATION = `
It starts with the Andes. A mountain range so relentless it left the Spanish empire
only one direction to expand: down, in a straight line, hugging the coast.

By the 1880s Chile had fought a war over nitrate fields and won a thousand miles of
desert it never expected to keep. Keeping it meant governing it, and governing it
meant building a state shaped like the land it grabbed.

The result nobody planned for: a country so narrow that a single earthquake can be
felt from one border to the other, and so long that its northern and southern tips
sit in completely different climates.
`.trim();

const UNBROKEN_NARRATION =
  "It starts with the Andes, a mountain range so relentless it left the Spanish " +
  "empire only one direction to expand. By the 1880s Chile had fought a war over " +
  "nitrate fields and won a thousand miles of desert it never expected to keep. " +
  "Keeping it meant governing it, and governing it meant building a state shaped " +
  "like the land it grabbed. The result nobody planned for is a country so narrow " +
  "that a single earthquake can be felt from one border to the other.";

test("a paragraphed narration produces a story and script that both validate", async () => {
  const reg = await registry();
  const episode = buildManualEpisode({
    title: "Why Chile Is So Incredibly Long",
    hook: HOOK,
    narration: PARAGRAPHED_NARRATION,
  });

  assert.doesNotThrow(() => reg.validate("story", reg.resolveVersion("story"), episode.story));
  assert.doesNotThrow(() => reg.validate("script", reg.resolveVersion("script"), episode.script));

  // One scene per paragraph, plus the hook as the opening scene.
  assert.equal(episode.script.scenes.length, 4);
  assert.equal(episode.script.scenes[0]!.narration, HOOK);
  assert.equal(episode.story.acts.length, 3);
});

test("the operator also owns the growth package: it validates and matches the operator's own words", async () => {
  const reg = await registry();
  const episode = buildManualEpisode({
    title: "Why Chile Is So Incredibly Long",
    hook: HOOK,
    narration: PARAGRAPHED_NARRATION,
    topic: "geography",
  });

  // Schema + relational contract both hold, so growth_package_release passes it through.
  assert.doesNotThrow(() => reg.validate("growth_package", reg.resolveVersion("growth_package"), episode.growth_package));
  assert.deepEqual(validateGrowthPackageSelection(episode.growth_package), []);
  assert.deepEqual(validateGrowthPackageReleaseability(episode.growth_package), []);

  // The click promise is the operator's, not an invention: selected title is
  // the operator's title, and the first-30 milestones are the opening scenes.
  const pkg = episode.growth_package;
  assert.equal(pkg.selected_title, "Why Chile Is So Incredibly Long");
  assert.equal(pkg.selected_title_family, "curiosity");
  assert.equal(pkg.opening_line, episode.script.scenes[0]!.narration.split(/(?<=[.!?])\s+/)[0]);
  assert.equal(pkg.first_30_seconds.zero_to_five, episode.script.scenes[1]!.narration);
  assert.equal(pkg.variants.length, 3);
  assert.deepEqual(pkg.variants.map((v) => v.family).sort(), ["conflict", "curiosity", "reversal"]);
});

test("a single unbroken block of narration still splits into scenes and validates", async () => {
  const reg = await registry();
  const episode = buildManualEpisode({
    title: "Why Chile Is So Incredibly Long",
    hook: HOOK,
    narration: UNBROKEN_NARRATION,
  });

  assert.doesNotThrow(() => reg.validate("story", reg.resolveVersion("story"), episode.story));
  assert.doesNotThrow(() => reg.validate("script", reg.resolveVersion("script"), episode.script));
  assert.ok(episode.script.scenes.length > 1, "a single blob still becomes more than one narration beat");
});

test("scene_index is sequential and act_index only ever names the three acts", () => {
  const episode = buildManualEpisode({
    title: "Why Chile Is So Incredibly Long",
    hook: HOOK,
    narration: PARAGRAPHED_NARRATION,
  });
  episode.script.scenes.forEach((s, i) => assert.equal(s.scene_index, i));
  for (const s of episode.script.scenes) assert.ok([0, 1, 2].includes(s.act_index));
  for (const a of episode.story.acts) assert.ok([0, 1, 2].includes(a.act_index));
});

test("very short narration still produces exactly three schema-valid acts", async () => {
  const reg = await registry();
  const episode = buildManualEpisode({
    title: "A Short One",
    hook: HOOK,
    narration: "Just one short sentence of narration to close it out.",
  });
  assert.doesNotThrow(() => reg.validate("story", reg.resolveVersion("story"), episode.story));
  assert.equal(episode.story.acts.length, 3);
  for (const a of episode.story.acts) {
    assert.ok(a.premise.length >= 20);
    assert.ok(a.target_words >= 50);
  }
});

test("a title, hook, or narration outside the schema's bounds is rejected before it reaches the store", () => {
  const base = { title: "A Fine Title", hook: HOOK, narration: PARAGRAPHED_NARRATION };
  assert.throws(() => buildManualEpisode({ ...base, title: "Hi" }), /title/);
  assert.throws(() => buildManualEpisode({ ...base, hook: "too short" }), /hook/);
  assert.throws(() => buildManualEpisode({ ...base, narration: "hi" }), /narration/);
});

test("the payoff is drawn verbatim from the operator's own closing line, never invented", () => {
  const episode = buildManualEpisode({
    title: "Why Chile Is So Incredibly Long",
    hook: HOOK,
    narration: PARAGRAPHED_NARRATION,
  });
  const lastScene = episode.script.scenes[episode.script.scenes.length - 1]!.narration;
  assert.equal(episode.story.payoff, lastScene);
});
