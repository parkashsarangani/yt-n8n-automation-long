/**
 * Cartoon-mode wiring: dialogue_script_writer, cartoon_visual_planner, and
 * the dialogue_voice worker, run through the real Runner (same code path as
 * production) against a FakeProvider/FakeSpeechProvider - zero network, zero
 * cost. graph.test.ts already proves cartoon.json is statically valid; this
 * proves a realistic payload from each new transformation actually survives
 * schema validation and does what its consumer downstream expects.
 */

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
import { FakeProvider, FakeSpeechProvider } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { makeDialogueVoiceWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });

const CAST_ROSTER = {
  characters: [
    { character_id: "nova", name: "Nova", voice_id: "voice-nova", rig: "pilot", personality: "skeptical, dry humor" },
    { character_id: "buddy", name: "Buddy", voice_id: "voice-buddy", rig: "pilot-2", personality: "enthusiastic, asks the obvious question" },
  ],
  default_voice_id: "voice-nova",
};

const STORY_PAYLOAD = {
  topic: "Why Chile is so incredibly long",
  title: "The Country That Refused To Stop",
  hook: "Chile is four thousand kilometres of coastline and almost no width.",
  acts: [
    { act_index: 0, act_title: "The shape", premise: "Establish the absurd geometry of it.", target_words: 60 },
    { act_index: 1, act_title: "The spine", premise: "The Andes drew the border before people did.", target_words: 60 },
    { act_index: 2, act_title: "The reach", premise: "Conquest stretched it further than planned.", target_words: 60 },
  ],
  payoff: "The shape is not politics. It is rock.",
  comment_hook: "Could you drive it in a week? Yes or no.",
  outro_line: "Send this to whoever thinks maps are boring.",
};

const DIALOGUE_SCRIPT_PAYLOAD = {
  scenes: [
    { scene_index: 0, act_index: 0, point: "open on the absurdity", narration: "Wait, Chile is HOW long?", speaker: "buddy", emotion: "surprised" },
    { scene_index: 1, act_index: 0, point: "the mountains decided", narration: "Longer than London to Baghdad. The Andes did that to you.", speaker: "nova", emotion: "neutral" },
    { scene_index: 2, act_index: 1, point: "payoff", narration: "It's rock. Not politics.", speaker: "nova", emotion: "happy" },
  ],
  word_count: 22,
};

const CARTOON_PLAN_PAYLOAD = {
  scenes: [
    {
      scene_index: 0,
      template_category: "cartoon",
      background_location: "bedroom",
      background_variant: "day",
      background_tone: "happy",
      framing: "two-shot",
      camera_motion: "static",
      listener_actor_id: "nova",
      speaker_emotion: "surprised",
      speaker_gesture: "hands-open",
      speaker_gaze_target: "auto",
      listener_emotion: "skeptical",
      listener_gesture: "idle",
      listener_gaze_target: "auto",
      visual_event: "none",
      ambient_motion: "subtle-parallax",
      speaker_emphasis: "scale-pop",
      cutaway_label: "",
    },
    {
      scene_index: 1,
      template_category: "cartoon",
      background_location: "classroom",
      background_variant: "normal",
      background_tone: "neutral",
      framing: "speaker-closeup",
      camera_motion: "push-in",
      listener_actor_id: "buddy",
      speaker_emotion: "neutral",
      speaker_gesture: "explain",
      speaker_gaze_target: "auto",
      listener_emotion: "thinking",
      listener_gesture: "idle",
      listener_gaze_target: "auto",
      visual_event: "screen-change",
      ambient_motion: "monitor-glow",
      speaker_emphasis: "rim-glow",
      cutaway_label: "",
    },
    {
      scene_index: 2,
      template_category: "cartoon",
      background_location: "street",
      background_variant: "night",
      background_tone: "dramatic",
      framing: "speaker-closeup",
      camera_motion: "static",
      listener_actor_id: "buddy",
      speaker_emotion: "happy",
      speaker_gesture: "idle",
      speaker_gaze_target: "camera",
      listener_emotion: "amused",
      listener_gesture: "idle",
      listener_gaze_target: "auto",
      visual_event: "reaction-pop",
      ambient_motion: "subtle-parallax",
      speaker_emphasis: "scale-pop",
      cutaway_label: "",
    },
  ],
};

async function harness(handler: (req: { prompt: string }, attempt: number) => unknown) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-cartoon-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider(handler as never);
  const providers = new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider });
  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: silent(), blobs: new MemoryBlobStore() });
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  const seed = async (schemaId: string, payload: unknown, producer: string) =>
    (
      await store.put({
        schema_id: schemaId,
        payload,
        produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
      })
    ).artifact;
  return { store, runner, agents, seed };
}

test("dialogue_script_writer produces a schema-valid multi-character script", async () => {
  const h = await harness(() => ({ payload: DIALOGUE_SCRIPT_PAYLOAD, confidence: { overall: 0.9 } }));
  const story = await h.seed("story", STORY_PAYLOAD, "story_architect");
  const cast = await h.seed("cast_roster", CAST_ROSTER, "human");

  const out = await h.runner.run(h.agents.get("dialogue_script_writer")!, [story.artifact_id, cast.artifact_id]);
  const payload = out.artifact.payload as typeof DIALOGUE_SCRIPT_PAYLOAD;

  assert.equal(out.artifact.schema_id, "script");
  assert.equal(payload.scenes.length, 3);
  const knownIds = new Set(CAST_ROSTER.characters.map((c) => c.character_id));
  for (const scene of payload.scenes) {
    assert.ok(scene.speaker && knownIds.has(scene.speaker), `unknown speaker "${scene.speaker}"`);
    assert.ok(scene.emotion, `scene ${scene.scene_index} missing emotion`);
  }
});

test("cartoon_visual_planner produces a schema-valid template_category=cartoon plan", async () => {
  const h = await harness(() => ({ payload: CARTOON_PLAN_PAYLOAD, confidence: { overall: 0.85 } }));
  const script = await h.seed("script", DIALOGUE_SCRIPT_PAYLOAD, "dialogue_script_writer");
  const cast = await h.seed("cast_roster", CAST_ROSTER, "human");

  const out = await h.runner.run(h.agents.get("cartoon_visual_planner")!, [script.artifact_id, cast.artifact_id]);
  const payload = out.artifact.payload as typeof CARTOON_PLAN_PAYLOAD;

  assert.equal(out.artifact.schema_id, "visual_plan");
  assert.equal(out.artifact.schema_version, "1.8.0");
  const knownIds = new Set(CAST_ROSTER.characters.map((c) => c.character_id));
  for (const scene of payload.scenes) {
    assert.equal(scene.template_category, "cartoon");
    assert.ok(knownIds.has(scene.listener_actor_id), `unknown listener "${scene.listener_actor_id}"`);
    assert.ok(scene.background_location.length > 0);
    assert.ok(scene.background_variant.length > 0);
    assert.ok(scene.speaker_emotion.length > 0);
    assert.ok(scene.listener_emotion.length > 0);
    assert.equal("template_data" in scene, false);
    assert.equal("search_terms" in scene, false);
  }
});

test("dialogue_voice routes each scene to its speaker's voice via the cast roster", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-cartoon-")), registry);
  const speech = new FakeSpeechProvider();
  const runner = new Runner({
    store,
    registry,
    prompts,
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
    media: { speech },
  });

  const scriptWithUnknownSpeaker = {
    scenes: [
      ...DIALOGUE_SCRIPT_PAYLOAD.scenes,
      { scene_index: 3, act_index: 1, point: "cameo", narration: "Who even are you?", speaker: "stranger", emotion: "surprised" },
    ],
  };

  const script = (
    await store.put({
      schema_id: "script",
      payload: scriptWithUnknownSpeaker,
      produced_by: { transformation: "dialogue_script_writer", version: "1", run_id: "t", provider: null },
    })
  ).artifact;
  const cast = (
    await store.put({
      schema_id: "cast_roster",
      payload: CAST_ROSTER,
      produced_by: { transformation: "human", version: "1", run_id: "t", provider: null },
    })
  ).artifact;

  const worker = makeDialogueVoiceWorker({ defaultVoiceId: "smoke-voice" });
  const out = await runner.run(worker, [script.artifact_id, cast.artifact_id]);
  const payload = out.artifact.payload as { voice_id: string; clips: Array<{ scene_index: number }> };

  assert.equal(payload.clips.length, 4);
  assert.equal(out.artifact.produced_by.provider, null);

  const voiceByScene = new Map(speech.calls.map((c, i) => [i, c.voice]));
  assert.equal(voiceByScene.get(0), "voice-buddy");
  assert.equal(voiceByScene.get(1), "voice-nova");
  assert.equal(voiceByScene.get(3), "voice-nova");
});
