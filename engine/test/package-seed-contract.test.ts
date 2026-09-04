/**
 * The scheduler -> intent -> growth_packager handoff, tested end to end.
 *
 * This contract broke silently once already: the scheduler encoded the
 * tournament winner as `RFC0009_PACKAGE_JSON:` + JSON, the prompt read
 * `RFC0009_PACKAGE_SEED=`, and the unit test asserted the scheduler's side
 * only. Every part passed its own test while the winning package was
 * discarded on every scheduled run -- exactly the integration-contract defect
 * that isolated tests cannot see. These assertions deliberately span the
 * component boundary: builder -> real schema -> the prompt that consumes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SchemaRegistry } from "../src/registry.ts";
import { packageSeedOf, type DiscoveryCandidate } from "../src/growth-scheduler.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const winner = (): DiscoveryCandidate => ({
  brief: "A dismissed mechanic warns that a machine is about to fail, then becomes the only person who can repair it.",
  genre: "drama",
  angle: "Underestimation becomes visible vindication after a concrete failure.",
  target_audience: "Adults who enjoy workplace reversal stories",
  curiosity_gap: "Why the ignored mechanic knew the failure was coming",
  emotional_engine: "injustice to anxiety to vindication",
  opening_visual: "A mechanic pointing at a frayed belt while a supervisor waves him away and the machine keeps running.",
  opening_line: "He pointed at the belt twice. His boss laughed the second time.",
  title_concepts: [
    { family: "curiosity", title: "The Mechanic Nobody Listened To" },
    { family: "conflict", title: "His Boss Laughed at the Warning" },
    { family: "reversal", title: "Then the Machine Finally Broke" },
  ],
  thumbnail_concepts: [
    { family: "curiosity", concept: "Ignored mechanic beside visibly frayed belt" },
    { family: "conflict", concept: "Supervisor dismissing mechanic beside running machine" },
    { family: "reversal", concept: "Mechanic repairing machine while coworkers watch" },
  ],
  scores: { clickability: 0.75, story_potential: 0.78, audience_size: 0.8, overall: 0.78 },
});

test("a scheduled run's intent validates against the real intent schema", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const seed = packageSeedOf(winner());
  assert.ok(seed, "the tournament winner must produce a seed");

  // Exactly what startRun() writes for a scheduled production run.
  const intent = {
    brief: winner().brief,
    target_duration_sec: 540,
    genre: "drama",
    image_style: "documentary_sketch",
    package_seed: seed,
  };

  assert.doesNotThrow(
    () => registry.validate("intent", "1.3.0", intent),
    "the TS seed type and intent@1.3.0 must not drift apart",
  );
});

test("a manual brief with no tournament behind it is still a valid intent", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  assert.doesNotThrow(() => registry.validate("intent", "1.3.0", {
    brief: "An operator typed this straight into the UI with no discovery run at all.",
    target_duration_sec: 540,
  }));
});

test("the packager prompt reads the typed field and no stale marker survives", async () => {
  const prompt = await readFile(path.join(ROOT, "prompts", "growth_packager", "1.md"), "utf8");

  assert.match(prompt, /intent\.package_seed/, "the prompt must consume the typed field");
  assert.doesNotMatch(prompt, /RFC0009_PACKAGE/, "the magic-string contract must be gone, not renamed");
  assert.match(prompt, /intent\.brief/, "premise still comes from the human-facing brief");
});
