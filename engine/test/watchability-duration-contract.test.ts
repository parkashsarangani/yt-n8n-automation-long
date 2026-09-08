import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { promptInputView } from "../src/prompt-inputs.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production graph threads intent through writer critic and release without creating another graph", async () => {
  const graph = JSON.parse(await readFile(path.join(ROOT, "graphs/illustrated_story.json"), "utf8")) as {
    graph_id: string;
    version: string;
    nodes: Array<{ id: string; in?: string[] }>;
  };
  assert.equal(graph.graph_id, "illustrated_story");
  assert.equal(graph.version, "9");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId.get("draft_script")?.in, ["approve_story", "package_release", "intent"]);
  assert.deepEqual(byId.get("watchability_report")?.in, ["approve_story", "draft_script", "package_release", "intent"]);
  assert.deepEqual(byId.get("watchability_release")?.in, ["draft_script", "creative_viability", "package_release", "intent"]);
});

test("writer and critic are pinned to duration-aware prompts", async () => {
  const writer = JSON.parse(await readFile(path.join(ROOT, "agents/narration_script_writer.json"), "utf8")) as any;
  const critic = JSON.parse(await readFile(path.join(ROOT, "agents/watchability_critic.json"), "utf8")) as any;
  assert.equal(writer.version, "6");
  assert.equal(writer.prompt, "narration_script_writer@6");
  assert.ok(writer.consumes.some((input: any) => input.as === "intent" && input.optional !== true));
  assert.equal(critic.version, "5");
  assert.equal(critic.prompt, "watchability_critic@5");
  assert.ok(critic.consumes.some((input: any) => input.as === "intent" && input.optional !== true));

  const writerPrompt = await readFile(path.join(ROOT, "prompts/narration_script_writer/6.md"), "utf8");
  const criticPrompt = await readFile(path.join(ROOT, "prompts/watchability_critic/5.md"), "utf8");
  assert.match(writerPrompt, /watchability_release_profile/);
  assert.match(writerPrompt, /Never return an unchanged prior draft/i);
  assert.match(criticPrompt, /actual episode duration/i);
  assert.match(criticPrompt, /compact episode/i);
  assert.match(criticPrompt, /Do not give compact episodes an easy pass/i);
});

test("writer and critic see the exact same derived 60s release profile", () => {
  const intent = {
    brief: "A 60 second production probe",
    target_duration_sec: 60,
    genre: "drama",
    constraints: ["truthful"],
  };
  const writer = promptInputView("narration_script_writer", "intent", intent) as any;
  const critic = promptInputView("watchability_critic", "intent", intent) as any;
  assert.deepEqual(writer.watchability_release_profile, critic.watchability_release_profile);
  assert.equal(writer.watchability_release_profile.profile, "compact");
  assert.equal(writer.watchability_release_profile.thresholds.hook, 0.82);
  assert.equal(writer.watchability_release_profile.thresholds.package_fidelity, 0.84);
  assert.equal(writer.watchability_release_profile.thresholds.first_30_fidelity, 0.70);
  assert.equal(writer.watchability_release_profile.thresholds.suspense, 0.68);
  assert.equal(writer.watchability_release_profile.average_threshold, 0.77);
});
