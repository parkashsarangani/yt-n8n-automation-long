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

test("cartoon compiler recovers from legacy template_data=placeholder", async () => {
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

  const plan = (await store.put({
    schema_id: "visual_plan",
    schema_version: "1.3.0",
    payload: { scenes: [{ scene_index: 0, template_category: "cartoon", template_data: "placeholder" }] },
    produced_by: { transformation: "cartoon_visual_planner", version: "2", run_id: "t", provider: null },
  })).artifact;
  const script = (await store.put({
    schema_id: "script",
    payload: { scenes: [{ scene_index: 0, point: "open", narration: "What is that?", speaker: "host", emotion: "surprised" }] },
    produced_by: { transformation: "dialogue_script_writer", version: "1", run_id: "t", provider: null },
  })).artifact;
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

  const out = await runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string; source: string }> };
  assert.equal(payload.scenes[0]!.source, "template");
  const data = JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string }; characters: Array<{ actorId: string; characterId: string; isSpeaking: boolean }> };
  assert.equal(data.background.location, "generic-room");
  assert.equal(data.characters[0]!.actorId, "host");
  assert.equal(data.characters[0]!.characterId, "pilot");
  assert.equal(data.characters[0]!.isSpeaking, true);
});
