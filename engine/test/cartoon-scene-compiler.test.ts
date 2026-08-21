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
    payload: {
      characters: [
        { character_id: "host", name: "Host", voice_id: "v1", rig: "pilot" },
        { character_id: "buddy", name: "Buddy", voice_id: "v2", rig: "pilot-2" },
      ],
    },
    produced_by: { transformation: "human", version: "1", run_id: "t", provider: null },
  })).artifact;
  return { registry, store, runner, cast };
}

test("cartoon compiler recovers from legacy template_data=placeholder", async () => {
  const h = await harness();
  const plan = (await h.store.put({
    schema_id: "visual_plan",
    schema_version: "1.3.0",
    payload: { scenes: [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }] },
    produced_by: { transformation: "cartoon_visual_planner", version: "2", run_id: "t", provider: null },
  })).artifact;
  const script = (await h.store.put({
    schema_id: "script",
    payload: { scenes: [{ scene_index: 0, point: "open", narration: "What is that?", speaker: "host", emotion: "surprised" }] },
    produced_by: { transformation: "dialogue_script_writer", version: "1", run_id: "t", provider: null },
  })).artifact;

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string; source: string }> };
  assert.equal(payload.scenes[0]!.source, "template");
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string }; characters: Array<{ actorId: string; characterId: string; isSpeaking: boolean }> };
  assert.equal(data.background.location, "generic-room");
  assert.equal(data.characters[0]!.actorId, "host");
  assert.equal(data.characters[0]!.characterId, "pilot");
  assert.equal(data.characters[0]!.isSpeaking, true);
});

test("cartoon compiler synthesizes staging when a legacy visual plan omits a script scene", async () => {
  const h = await harness();
  const plan = (await h.store.put({
    schema_id: "visual_plan",
    schema_version: "1.3.0",
    payload: {
      scenes: [{
        scene_index: 0,
        template_category: "cartoon",
        template_data: JSON.stringify({
          background: { location: "generic-room", variant: "warm-day", tone: "neutral" },
          camera: { type: "static" },
          characters: [{ actorId: "host", characterId: "pilot", x: 280, y: 380, scale: 1, isSpeaking: true }],
        }),
      }],
    },
    produced_by: { transformation: "cartoon_visual_planner", version: "2", run_id: "t", provider: null },
  })).artifact;
  const script = (await h.store.put({
    schema_id: "script",
    payload: {
      scenes: [
        { scene_index: 0, point: "setup", narration: "Why does this happen?", speaker: "host", emotion: "neutral" },
        { scene_index: 1, point: "reaction", narration: "Wait, seriously?", speaker: "buddy", emotion: "surprised" },
      ],
    },
    produced_by: { transformation: "dialogue_script_writer", version: "1", run_id: "t", provider: null },
  })).artifact;

  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ scene_index: number; template_data: string; source: string }> };
  assert.equal(payload.scenes.length, 2);
  assert.equal(payload.scenes[1]!.scene_index, 1);
  assert.equal(payload.scenes[1]!.source, "template");
  const missingSceneData = JSON.parse(payload.scenes[1]!.template_data) as { background: { location: string }; characters: Array<{ actorId: string; characterId: string; isSpeaking: boolean }> };
  assert.equal(missingSceneData.background.location, "generic-room");
  assert.equal(missingSceneData.characters[0]!.actorId, "buddy");
  assert.equal(missingSceneData.characters[0]!.characterId, "pilot-2");
  assert.equal(missingSceneData.characters[0]!.isSpeaking, true);
});
