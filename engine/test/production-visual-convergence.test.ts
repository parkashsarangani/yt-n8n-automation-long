import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  visualDirectorCoverageErrors,
  repairVisualDirectorNarration,
  splitApprovedNarration,
} from "../src/agent-validators.ts";
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

test("production visual director v5 is full-episode, illustration-first and keeps its representation + payoff + fallback contracts", async () => {
  const agent = JSON.parse(await readFile(path.join(ROOT, "agents/visual_director.json"), "utf8")) as {
    version: string;
    prompt: string;
    produces_version?: string;
    consumes: Array<{ as: string }>;
    model: { max_output_tokens?: number };
  };
  assert.equal(agent.version, "5");
  assert.equal(agent.prompt, "visual_director@5");
  assert.equal(agent.produces_version, "1.2.0", "the expressive semantic-scene schema must be the produced version");
  assert.equal(agent.model.max_output_tokens, 24000, "do not hide payload incompatibility by truncating the production plan budget");
  assert.ok(agent.consumes.some((input) => input.as === "intent"));

  const prompt = await readFile(path.join(ROOT, "prompts/visual_director/5.md"), "utf8");
  // Full-episode coverage + measured-voice beat density.
  assert.match(prompt, /Cover EVERY script scene in order/i);
  assert.match(prompt, /ceil\(scene_voice_seconds\s*\/\s*10\)/i);
  // Engine owns the exact narration bytes; the model owns beat count/semantics.
  assert.match(prompt, /engine canonically derives the exact beat narration bytes/i);
  // Genuine alternate representations.
  assert.match(prompt, /`routing\.preferred` and `routing\.fallback` MUST differ/i);
  assert.match(prompt, /Never declare an alternate you cannot actually render/i);
  // Representation is chosen by information structure, and the expressive kinds exist.
  assert.match(prompt, /REPRESENTATION SELECTION/i);
  assert.match(prompt, /`cause_chain`:/i);
  assert.match(prompt, /`branching`:/i);
  assert.match(prompt, /one source node MUST have >=2 outgoing edges/i);
  assert.match(prompt, /DOUBLE-DOSE STYLE REGRESSION RULE/i);
  // No generic filler; payoff must resolve, not summarise.
  assert.match(prompt, /decorative boxes, or narration-restating card is failure/i);
  assert.match(prompt, /final payoff must visibly RESOLVE the story/i);
  assert.match(prompt, /Do not finish with another summary node chain/i);
  // Continuity first-identity-wins and no generated pseudo-text.
  assert.match(prompt, /First non-empty `continuity\.identity` wins/i);
  assert.match(prompt, /no pseudo-writing\/readable gibberish/i);
});

test("splitApprovedNarration slices immutable script text into contiguous phrase-aligned chunks", () => {
  const text = "She checked the log. The line was impossible; bed twelve was empty. Nobody had signed.";
  for (const count of [1, 2, 3, 4]) {
    const chunks = splitApprovedNarration(text, count);
    assert.equal(chunks.length, count);
    assert.equal(chunks.join(""), text, "concatenation must reproduce the source byte-for-byte");
    assert.ok(chunks.every((chunk) => chunk.length > 0), "no empty chunk");
  }
  // Splits land at phrase boundaries, not mid-word.
  const two = splitApprovedNarration(text, 2);
  assert.ok(/\S$/.test(two[0]!) && /^\s|^\S/.test(two[1]!));
  assert.match(two[0]!.trimEnd(), /[.!?;:,]$/);
});

test("visual director coverage: the engine owns the exact bytes, the model owns beat count/semantics", () => {
  const script = { scenes: [
    { scene_index: 0, narration: "She checked the overnight log. One line did not add up." },
    { scene_index: 1, narration: "Bed twelve was empty. Nobody had signed for the dose." },
  ] };

  // A plan whose beat narration is PARAPHRASED is repaired to byte-exact text
  // from the approved script (the model no longer has to retype punctuation).
  const paraphrased: { beats: Array<{ id: string; scene_index: number; beat_index: number; narration: string }> } = { beats: [
    { id: "beat_001", scene_index: 0, beat_index: 0, narration: "she checked the log" },
    { id: "beat_002", scene_index: 0, beat_index: 1, narration: "a line didn't add up" },
    { id: "beat_003", scene_index: 1, beat_index: 0, narration: "bed 12 empty, no signature" },
  ] };
  const repairs = repairVisualDirectorNarration(paraphrased, script);
  assert.ok(repairs.length >= 2, "each drifted beat is repaired");
  assert.equal(
    paraphrased.beats.filter((b) => b.scene_index === 0).map((b) => b.narration).join(""),
    script.scenes[0]!.narration,
    "scene 0 beats now concatenate to the approved narration exactly",
  );
  assert.equal(
    paraphrased.beats.filter((b) => b.scene_index === 1).map((b) => b.narration).join(""),
    script.scenes[1]!.narration,
  );
  assert.deepEqual(visualDirectorCoverageErrors(paraphrased, script), [], "after repair, coverage is clean");

  // Structural defects the engine CANNOT silently repair still hard-fail:
  // a missing scene, non-contiguous beat_index, and non-sequential global ids.
  const missingScene = visualDirectorCoverageErrors(
    { beats: [{ id: "beat_001", scene_index: 0, beat_index: 0, narration: "x" }] },
    script,
  );
  assert.ok(missingScene.some((e) => /scene 1: visual plan has no beats/.test(e)));

  const misnumbered = visualDirectorCoverageErrors({ beats: [
    { id: "beat_001", scene_index: 0, beat_index: 0, narration: "a" },
    { id: "beat_003", scene_index: 1, beat_index: 1, narration: "b" },
  ] }, script);
  assert.ok(misnumbered.some((e) => /beat_index must be contiguous from 0/.test(e)));
  assert.ok(misnumbered.some((e) => /expected global id beat_002/.test(e)));

  const extraScene = visualDirectorCoverageErrors({ beats: [
    { id: "beat_001", scene_index: 0, beat_index: 0, narration: "a" },
    { id: "beat_002", scene_index: 1, beat_index: 0, narration: "b" },
    { id: "beat_003", scene_index: 9, beat_index: 0, narration: "c" },
  ] }, script);
  assert.ok(extraScene.some((e) => /scene\(s\) not present in the approved script: 9/.test(e)));
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
