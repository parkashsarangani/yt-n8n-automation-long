import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeProvider, type FakeHandler } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { loadAgentDefs } from "../src/catalog.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const STORY_PAYLOAD = {
  topic: "Why 8 hours of sleep can still feel like nothing",
  title: "The Alarm Clock Is Innocent",
  hook: "The clock says eight hours, but the person still feels wrecked.",
  acts: [
    { act_index: 0, act_title: "The mismatch", premise: "Show the character waking up tired despite enough hours.", target_words: 120 },
    { act_index: 1, act_title: "The leaks", premise: "Show phone, stress, coffee, and mental load stealing recovery.", target_words: 140 },
    { act_index: 2, act_title: "The protection", premise: "Show a small routine change that protects the same eight hours.", target_words: 120 },
  ],
  payoff: "The number of hours is not the whole story; protected recovery matters.",
  comment_hook: "What steals your sleep the most?",
  outro_line: "Send this to someone who says they slept enough.",
};

const CAST_PAYLOAD = {
  characters: [
    { character_id: "host", name: "Host", voice_id: "voice-host", rig: "pilot" },
    { character_id: "buddy", name: "Buddy", voice_id: "voice-buddy", rig: "pilot-2" },
  ],
  default_voice_id: "voice-host",
};

function silent() {
  return { log: () => { }, warn: () => { }, error: () => { } };
}

async function harness(handler: FakeHandler) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-dialogue-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider(handler);
  const providers = new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider });
  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: silent(), blobs: new MemoryBlobStore() });
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  return { store, runLog, provider, runner, agents };
}

function point(index: number, functionName: string) {
  const prop = index < 6 ? "alarm clock" : index < 12 ? "coffee" : "calendar";
  return `action=Host handles sleep beat ${index}; prop=${prop}; function=${functionName}; value=viewer sees why the same eight hours feels different`;
}

function scene(index: number, narration: string) {
  return {
    scene_index: index,
    act_index: index < 6 ? 0 : index < 13 ? 1 : 2,
    point: point(index, index === 0 ? "opening_problem" : index === 18 ? "payoff_resolution practical_action callback" : "routine_escalation engagement"),
    narration,
    speaker: index % 2 === 0 ? "host" : "buddy",
    emotion: index % 2 === 0 ? "surprised" : "neutral",
  };
}

function scriptPayload(lines: string[]) {
  return {
    scenes: lines.map((line, index) => scene(index, line)),
    word_count: lines.join(" ").trim().split(/\s+/).filter(Boolean).length,
  };
}

const BAD_LINES = [
  "Wait. I'm still tired.",
  "Eight hours, technically.",
  "That seems illegal.",
  "Your phone disagrees.",
  "It was charging.",
  "You were scrolling.",
  "Only a little.",
  "Define little.",
  "Don't do that.",
  "I got eight hours and somehow my soul still wants a refund.",
  "Your body was in bed while your brain kept opening tabs.",
  "The coffee at six was still arguing with midnight.",
  "Your calendar also scheduled tomorrow inside your pillow somehow.",
  "The glowing rectangle ran a tiny casino beside your face.",
  "Stress does not clock out because the blanket arrives.",
  "You rested like a laptop with twenty tabs still open.",
  "That is rude enough to sound medically adjacent but useful.",
  "Tonight the phone sleeps outside and the alarm stays boring.",
  "Same eight hours, but this time we stop leaking them.",
];

const GOOD_LINES = [
  "Wait. I'm still tired.",
  "Eight hours, technically.",
  "That seems illegal.",
  "Your phone disagrees.",
  "It was charging.",
  "You were scrolling.",
  "Only a little.",
  "Define little.",
  "Don't do that.",
  "Fine. Too much.",
  "Your body was in bed while your brain kept opening tabs.",
  "The coffee at six was still arguing with midnight.",
  "Your calendar also scheduled tomorrow inside your pillow somehow.",
  "So the bed was decorative.",
  "Basically rude furniture.",
  "Tonight, phone outside.",
  "And coffee earlier.",
  "Same eight hours?",
  "Less leaking.",
];

test("dialogue_script_writer retries before storing a script with too few short lines", async () => {
  const h = await harness((_req, attempt) => ({
    payload: attempt === 0 ? scriptPayload(BAD_LINES) : scriptPayload(GOOD_LINES),
    confidence: { overall: attempt === 0 ? 0.72 : 0.9 },
  }));

  const story = await h.store.put({
    schema_id: "story",
    payload: STORY_PAYLOAD,
    produced_by: { transformation: "story_architect", version: "1", run_id: "run_seed", provider: null },
  });
  const cast = await h.store.put({
    schema_id: "cast_roster",
    schema_version: "1.0.0",
    payload: CAST_PAYLOAD,
    produced_by: { transformation: "human", version: "1", run_id: "run_seed", provider: null },
  });

  const out = await h.runner.run(h.agents.get("dialogue_script_writer")!, [story.artifact.artifact_id, cast.artifact.artifact_id]);

  assert.equal(out.attempts, 2);
  assert.equal(h.provider.calls.length, 2);
  assert.match(h.provider.calls[1]!.prompt, /natural dialogue gate failed/);
  assert.match(h.provider.calls[1]!.prompt, /9\/19 lines are 10 words or fewer/);
  assert.match(h.provider.calls[1]!.prompt, /at least half \(10\/19\) must be short/);

  const payload = out.artifact.payload as { scenes: Array<{ narration: string }> };
  const shortLines = payload.scenes.filter((entry) => entry.narration.trim().split(/\s+/).filter(Boolean).length <= 10).length;
  assert.equal(shortLines, 14);
  assert.equal(out.artifact.produced_by.version, "7");

  const records = await h.runLog.all();
  assert.deepEqual(records.map((record) => record.status), ["schema_invalid", "ok"]);
  assert.match(records[0]!.error ?? "", /Rewrite as short, human, situational dialogue/);
});
