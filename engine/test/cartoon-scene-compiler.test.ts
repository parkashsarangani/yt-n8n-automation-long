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

test("cartoon compiler recovers from legacy template_data=placeholder with contextual staging", async () => {
  const h = await harness();
  const plan = await putLegacyPlan(h, [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }]);
  const script = await putScript(h, [{ scene_index: 0, point: "open", narration: "That alarm woke me up again.", speaker: "host", emotion: "surprised" }]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string; source: string }> };
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string }; characters: Array<{ actorId: string; characterId: string; isSpeaking: boolean; motionOffsetFrames: number }> };
  assert.equal(payload.scenes[0]!.source, "template");
  assert.equal(data.background.location, "bedroom");
  assert.equal(data.characters[0]!.actorId, "host");
  assert.equal(data.characters[0]!.characterId, "pilot");
  assert.equal(data.characters[0]!.isSpeaking, true);
  assert.equal(data.characters[0]!.motionOffsetFrames, 0);
});

test("missing legacy plan scenes synthesize varied staging and non-repeating motion phase", async () => {
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
    { scene_index: 2, point: "reveal", narration: "And I had not even opened it.", speaker: "host", emotion: "concerned" },
  ]);

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ scene_index: number; template_data: string }> };
  assert.equal(payload.scenes.length, 3);

  const scene1 = JSON.parse(payload.scenes[1]!.template_data) as { background: { location: string }; characters: Array<{ actorId: string; motionOffsetFrames: number }> };
  const scene2 = JSON.parse(payload.scenes[2]!.template_data) as { camera: { type: string }; characters: Array<{ actorId: string; motionOffsetFrames: number }> };
  assert.equal(scene1.background.location, "office");
  assert.equal(scene1.characters[0]!.actorId, "buddy");
  assert.equal(scene1.characters[0]!.motionOffsetFrames, 41);
  assert.equal(scene2.camera.type, "zoom");
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
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string; variant: string } };
  assert.deepEqual(data.background, { location: "living-room", variant: "day", tone: "neutral" });
});

test("fallback reaction emphasis keeps the speaking actor on screen", async () => {
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
    characters: Array<{ actorId: string; isSpeaking: boolean; scale: number }>;
  };
  assert.equal(scene5.characters.length, 2);
  assert.ok(scene5.characters.some((character) => character.isSpeaking === true));
  assert.equal(scene5.characters.find((character) => character.isSpeaking)!.actorId, "buddy");
});
