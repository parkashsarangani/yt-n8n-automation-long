import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { visualDirectorCoverageErrors } from "../src/agent-validators.ts";
import { sliceCharacterAlignment } from "../src/workers/visual-timeline-render.ts";
import { buildVisualTimelineManifest } from "../src/workers/visual-timeline-manifest.ts";
import { assessVisualBeatRelease } from "../src/workers/visual-beat-release.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production illustrated graph uses RFC0010 visual stack and not the legacy illustrated asset leg", async () => {
  const graph = JSON.parse(await readFile(path.join(ROOT, "graphs/illustrated_story.json"), "utf8")) as {
    version: string;
    nodes: Array<{ id: string; transformation?: string }>;
  };
  const tx = graph.nodes.map((node) => node.transformation).filter(Boolean);
  assert.equal(graph.version, "9");
  assert.ok(tx.includes("visual_director"));
  assert.ok(tx.includes("visual_beat_assets"));
  assert.ok(tx.includes("visual_timeline"));
  assert.ok(tx.includes("visual_beat_release"));
  assert.ok(tx.includes("visual_timeline_render"));
  assert.equal(tx.includes("episode_director"), false);
  assert.equal(tx.includes("illustrated_scene_assets"), false);
});

test("production visual director is full-episode and illustration-first", async () => {
  const agent = JSON.parse(await readFile(path.join(ROOT, "agents/visual_director.json"), "utf8")) as {
    prompt: string;
    consumes: Array<{ as: string }>;
  };
  assert.equal(agent.prompt, "visual_director@2");
  assert.ok(agent.consumes.some((input) => input.as === "intent"));
  const prompt = await readFile(path.join(ROOT, "prompts/visual_director/2.md"), "utf8");
  assert.match(prompt, /Cover EVERY narration scene/i);
  assert.match(prompt, /Never stop at 90–120 seconds/i);
  assert.match(prompt, /ILLUSTRATION FIRST/i);
  assert.match(prompt, /final takeaway.*visible payoff\/transformation/is);
});

test("visual director hard coverage validator rejects truncated or paraphrased production plans", () => {
  const script = { scenes: [
    { scene_index: 0, narration: "Exact opening." },
    { scene_index: 1, narration: "Exact closing." },
  ] };
  assert.deepEqual(visualDirectorCoverageErrors({ beats: [
    { id: "beat_001", scene_index: 0, beat_index: 0, narration: "Exact opening." },
    { id: "beat_002", scene_index: 1, beat_index: 0, narration: "Exact closing." },
  ] }, script), []);

  const truncated = visualDirectorCoverageErrors({ beats: [
    { id: "beat_001", scene_index: 0, beat_index: 0, narration: "Exact opening." },
  ] }, script);
  assert.ok(truncated.some((error) => /scene 1: visual plan has no beats/.test(error)));

  const paraphrased = visualDirectorCoverageErrors({ beats: [
    { id: "beat_001", scene_index: 0, beat_index: 0, narration: "Opening paraphrase." },
    { id: "beat_002", scene_index: 1, beat_index: 0, narration: "Exact closing." },
  ] }, script);
  assert.ok(paraphrased.some((error) => /does not exactly reproduce/.test(error)));
});

test("beat audio alignment is sliced and rebased for phrase-aware production captions", () => {
  const sliced = sliceCharacterAlignment({
    characters: ["A", " ", "B", "C"],
    character_start_times_seconds: [0, 0.2, 0.3, 0.5],
    character_end_times_seconds: [0.2, 0.3, 0.5, 0.7],
  }, 0.25, 0.6);
  assert.ok(sliced);
  assert.deepEqual(sliced!.characters, [" ", "B", "C"]);
  assert.deepEqual(sliced!.character_start_times_seconds, [0, 0.05, 0.25]);
  assert.deepEqual(sliced!.character_end_times_seconds, [0.05, 0.25, 0.35]);
});

test("compatibility manifest never degrades a valid declared alternate", () => {
  const manifest = buildVisualTimelineManifest(
    { beats: [
      { id: "beat_001", scene_index: 0, status: "fallback", resolved_mode: "generated_image", image_uri: "blob://sha256:" + "a".repeat(64) },
      { id: "beat_002", scene_index: 1, status: "resolved", resolved_mode: "motion_graphic", template_category: "explanation", template_data: "{}" },
    ] },
    { beats: [
      { id: "beat_001", scene_index: 0, duration_sec: 2, image_uri: "blob://sha256:" + "a".repeat(64), continuity_group: "", narration: "One" },
      { id: "beat_002", scene_index: 1, duration_sec: 3, template_category: "explanation", template_data: "{}", continuity_group: "", narration: "Two" },
    ] },
  );
  assert.equal(manifest.degraded_count, 0);
  assert.equal(manifest.scenes[0]!["source"], "primary");
  assert.equal(manifest.scenes[1]!["source"], "template");
});

test("RFC0010 production release blocks unavailable/generic/why-failure beats but allows declared alternates", () => {
  const good = assessVisualBeatRelease(
    { beats: [
      { id: "beat_001", scene_index: 0, status: "fallback", resolved_mode: "generated_image", semantic_verified: true },
    ] },
    { beats: [
      { id: "beat_001", scene_index: 0, image_uri: "blob://sha256:" + "b".repeat(64) },
    ], total_duration_sec: 2 },
  );
  assert.deepEqual(good.failures, []);
  assert.equal(good.fallbackScenes, 1);
  assert.match(good.warnings.join(" "), /declared semantic alternate/);

  const bad = assessVisualBeatRelease(
    { beats: [
      { id: "beat_001", scene_index: 0, status: "unavailable", resolved_mode: null, semantic_verified: false, generic_filler: true, why_failure: true },
    ] },
    { beats: [], total_duration_sec: 0 },
  );
  assert.ok(bad.failures.some((failure) => /unavailable visual/.test(failure)));
  assert.ok(bad.failures.some((failure) => /generic filler/.test(failure)));
  assert.ok(bad.failures.some((failure) => /why-failure/.test(failure)));
});

test("timeline render reports the real image container (free-first NVIDIA klein returns JPEG, not PNG)", async () => {
  const { sniffImageMediaType } = await import("../src/workers/visual-timeline-render.ts");
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "image/png");
  const webp = new Uint8Array(16); webp.set([0x52, 0x49, 0x46, 0x46], 0); webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(sniffImageMediaType(webp), "image/webp");
});
