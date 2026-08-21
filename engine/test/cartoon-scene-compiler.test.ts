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
import { Runner } from "../src/runner.ts";
import { makeCartoonSceneCompilerWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log() {}, warn() {}, error() {} });

async function harness() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "cartoon-compiler-")), registry);
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
  });
  const cast = (await store.put({
    schema_id: "cast_roster",
    payload: { characters: [
      { character_id: "host", name: "Host", voice_id: "v1", rig: "pilot" },
      { character_id: "buddy", name: "Buddy", voice_id: "v2", rig: "pilot-2" },
    ] },
    produced_by: { transformation: "human", version: "1", run_id: "t", provider: null },
  })).artifact;
  return { store, runner, cast };
}

async function putScript(h: Awaited<ReturnType<typeof harness>>, scenes: unknown[]) {
  return (await h.store.put({
    schema_id: "script",
    payload: { scenes },
    produced_by: { transformation: "dialogue_script_writer", version: "2", run_id: "t", provider: null },
  })).artifact;
}

async function putLegacyPlan(h: Awaited<ReturnType<typeof harness>>, scenes: unknown[]) {
  return (await h.store.put({
    schema_id: "visual_plan",
    schema_version: "1.3.0",
    payload: { scenes },
    produced_by: { transformation: "cartoon_visual_planner", version: "2", run_id: "t", provider: null },
  })).artifact;
}

async function putCurrentPlan(h: Awaited<ReturnType<typeof harness>>, scenes: unknown[]) {
  return (await h.store.put({
    schema_id: "visual_plan",
    schema_version: "1.7.0",
    payload: { scenes },
    produced_by: { transformation: "cartoon_visual_planner", version: "7", run_id: "t", provider: null },
  })).artifact;
}

function directedScene(scene_index: number, overrides: Record<string, unknown> = {}) {
  return {
    scene_index,
    template_category: "cartoon",
    background_location: "living-room",
    background_variant: "day",
    background_tone: "neutral",
    framing: "two-shot",
    camera_motion: "static",
    listener_actor_id: "buddy",
    speaker_emotion: "neutral",
    speaker_gesture: "idle",
    speaker_gaze_target: "auto",
    listener_emotion: "neutral",
    listener_gesture: "idle",
    listener_gaze_target: "auto",
    visual_event: "none",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: "",
    ...overrides,
  };
}

test("cartoon compiler recovers from legacy template_data=placeholder with contextual staging", async () => {
  const h = await harness();
  const plan = await putLegacyPlan(h, [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }]);
  const script = await putScript(h, [{ scene_index: 0, point: "open", narration: "That alarm woke me up again.", speaker: "host", emotion: "surprised" }]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string; source: string }> };
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string; ambientMotion: string }; visualEvent: { type: string }; speakerEmphasis: string; characters: Array<{ actorId: string; characterId: string; isSpeaking: boolean; motionOffsetFrames: number }> };
  assert.equal(payload.scenes[0]!.source, "template");
  assert.equal(data.background.location, "bedroom");
  assert.equal(data.background.ambientMotion, "subtle-parallax");
  assert.equal(data.visualEvent.type, "alarm-pulse");
  assert.equal(data.speakerEmphasis, "rim-glow");
  assert.equal(data.characters[0]!.actorId, "host");
  assert.equal(data.characters[0]!.characterId, "pilot");
  assert.equal(data.characters[0]!.isSpeaking, true);
  assert.equal(data.characters[0]!.motionOffsetFrames, 0);
});

test("missing legacy plan scenes preserve environment continuity and restrained closeups", async () => {
  const h = await harness();
  const plan = await putLegacyPlan(h, [{
    scene_index: 0,
    template_category: "cartoon",
    template_data: JSON.stringify({
      background: { location: "living-room", variant: "day", tone: "neutral" },
      camera: { type: "static" },
      characters: [{ actorId: "host", characterId: "pilot", x: 280, y: 380, scale: 1, isSpeaking: true }],
    }),
  }]);
  const script = await putScript(h, [
    { scene_index: 0, point: "setup", narration: "Why does this happen?", speaker: "host", emotion: "neutral" },
    { scene_index: 1, point: "reaction", narration: "That meeting invite ruined my morning.", speaker: "buddy", emotion: "surprised" },
    { scene_index: 2, point: "reveal", narration: "And I had not even opened it.", speaker: "host", emotion: "scared" },
  ]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ scene_index: number; template_data: string }> };
  assert.equal(payload.scenes.length, 3);

  const scene1 = JSON.parse(payload.scenes[1]!.template_data) as { background: { location: string; variant: string; ambientMotion: string }; visualEvent: { type: string }; characters: Array<{ actorId: string; motionOffsetFrames: number }> };
  const scene2 = JSON.parse(payload.scenes[2]!.template_data) as { background: { location: string; variant: string; tone: string }; camera: { type: string; from: number; to: number }; characters: Array<{ actorId: string; motionOffsetFrames: number; scale: number }> };
  assert.deepEqual({ location: scene1.background.location, variant: scene1.background.variant }, { location: "office", variant: "day" });
  assert.equal(scene1.background.ambientMotion, "monitor-glow");
  assert.equal(scene1.visualEvent.type, "audience-silhouette");
  assert.equal(scene1.characters[0]!.actorId, "buddy");
  assert.equal(scene1.characters[0]!.motionOffsetFrames, 41);
  assert.deepEqual({ location: scene2.background.location, variant: scene2.background.variant }, { location: "office", variant: "day" });
  assert.equal(scene2.background.tone, "neutral");
  assert.equal(scene2.camera.type, "zoom");
  assert.ok(scene2.camera.to - scene2.camera.from <= 0.02);
  assert.ok(scene2.characters[0]!.scale <= 1.30);
  assert.equal(scene2.characters[0]!.motionOffsetFrames, 82);
});

test("fallback keyword matching uses whole words instead of unrelated substrings", async () => {
  const h = await harness();
  const plan = await putLegacyPlan(h, [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }]);
  const script = await putScript(h, [{
    scene_index: 0,
    point: "setup",
    narration: "The embedded contest update changed nothing.",
    speaker: "host",
    emotion: "neutral",
  }]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string }> };
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string; variant: string; tone: string; ambientMotion: string } };
  assert.deepEqual({ location: data.background.location, variant: data.background.variant, tone: data.background.tone }, { location: "living-room", variant: "day", tone: "neutral" });
  assert.equal(data.background.ambientMotion, "subtle-parallax");
});

test("metaphorical alarm language does not teleport a continuing scene to a bedroom", async () => {
  const h = await harness();
  const plan = await putLegacyPlan(h, [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }]);
  const script = await putScript(h, [
    { scene_index: 0, point: "setup", narration: "I got one weird text.", speaker: "host", emotion: "neutral" },
    { scene_index: 1, point: "reaction", narration: "That sets off the alarm in my head.", speaker: "buddy", emotion: "scared" },
  ]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string }> };
  const scene0 = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string; variant: string }; visualEvent: { type: string } };
  const scene1 = JSON.parse(payload.scenes[1]!.template_data) as { background: { location: string; variant: string; tone: string }; visualEvent: { type: string } };
  assert.deepEqual({ location: scene0.background.location, variant: scene0.background.variant }, { location: "living-room", variant: "day" });
  assert.deepEqual({ location: scene1.background.location, variant: scene1.background.variant }, { location: "living-room", variant: "day" });
  assert.equal(scene1.background.tone, "neutral");
  assert.equal(scene1.visualEvent.type, "alarm-pulse");
});

test("directed closeups and push-ins stay inside production framing limits", async () => {
  const h = await harness();
  const plan = await putCurrentPlan(h, [directedScene(0, {
    framing: "speaker-closeup",
    camera_motion: "push-in",
    speaker_emotion: "scared",
  })]);
  const script = await putScript(h, [{ scene_index: 0, point: "panic", narration: "Can we talk?", speaker: "host", emotion: "scared" }]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string }> };
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { tone: string }; camera: { from: number; to: number }; characters: Array<{ scale: number }> };
  assert.equal(data.background.tone, "neutral");
  assert.ok(data.characters[0]!.scale <= 1.30);
  assert.ok(data.camera.to - data.camera.from <= 0.03);
});

test("directed visual events and speaker emphasis pass through to the renderer", async () => {
  const h = await harness();
  const plan = await putCurrentPlan(h, [directedScene(0, {
    background_location: "office",
    background_variant: "day",
    visual_event: "metaphor-cutaway",
    ambient_motion: "monitor-glow",
    speaker_emphasis: "listener-dim",
    cutaway_label: "NOT A WOLF",
  })]);
  const script = await putScript(h, [{ scene_index: 0, point: "callback", narration: "Kevin is not a wolf.", speaker: "host", emotion: "neutral" }]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string }> };
  const data = JSON.parse(payload.scenes[0]!.template_data) as {
    background: { ambientMotion: string };
    visualEvent: { type: string; label: string };
    speakerEmphasis: string;
  };
  assert.equal(data.background.ambientMotion, "monitor-glow");
  assert.deepEqual(data.visualEvent, { type: "metaphor-cutaway", label: "NOT A WOLF" });
  assert.equal(data.speakerEmphasis, "listener-dim");
});

test("fallback reaction emphasis keeps the speaking actor on screen without extreme scale mismatch", async () => {
  const h = await harness();
  const plan = await putLegacyPlan(h, [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }]);
  const scenes = Array.from({ length: 6 }, (_, scene_index) => ({
    scene_index,
    point: `beat-${scene_index}`,
    narration: scene_index === 5 ? "You heard me correctly." : `Line ${scene_index}.`,
    speaker: scene_index % 2 === 0 ? "host" : "buddy",
    emotion: scene_index === 5 ? "surprised" : "neutral",
  }));
  const script = await putScript(h, scenes);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ scene_index: number; template_data: string }> };
  const scene5 = JSON.parse(payload.scenes.find((scene) => scene.scene_index === 5)!.template_data) as {
    camera: { type: string };
    characters: Array<{ actorId: string; isSpeaking: boolean; scale: number }>;
  };
  assert.equal(scene5.characters.length, 2);
  assert.ok(scene5.characters.some((character) => character.isSpeaking === true));
  assert.equal(scene5.characters.find((character) => character.isSpeaking)!.actorId, "buddy");
  const scales = scene5.characters.map((character) => character.scale);
  assert.ok(Math.max(...scales) / Math.min(...scales) <= 1.15);
  assert.equal(scene5.camera.type, "static");
});
