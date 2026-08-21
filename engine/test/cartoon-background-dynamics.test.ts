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
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "cartoon-background-")), registry);
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

async function putPlan(h: Awaited<ReturnType<typeof harness>>, scenes: unknown[]) {
  return (await h.store.put({
    schema_id: "visual_plan",
    schema_version: "1.7.0",
    payload: { scenes },
    produced_by: { transformation: "cartoon_visual_planner", version: "8", run_id: "t", provider: null },
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
    visual_event: "reaction-pop",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: "",
    ...overrides,
  };
}

async function compileOne(scriptNarration: string, planOverrides: Record<string, unknown> = {}, point = "opening") {
  const h = await harness();
  const script = await putScript(h, [{ scene_index: 0, point, narration: scriptNarration, speaker: "host", emotion: "neutral" }]);
  const plan = await putPlan(h, [directedScene(0, planOverrides)]);
  const out = await h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]);
  const payload = out.artifact.payload as { scenes: Array<{ template_data: string }> };
  return JSON.parse(payload.scenes[0]!.template_data) as { background: { location: string; variant: string; ambientMotion: string }; visualEvent: { type: string } };
}

test("schema and compiler allow the planner to request airplane and engineering backgrounds directly", async () => {
  const cabin = await compileOne("I got the airplane window seat and I can see the wing.", {
    background_location: "airplane-cabin",
    background_variant: "day",
    ambient_motion: "window-light",
  });
  assert.equal(cabin.background.location, "airplane-cabin");
  assert.equal(cabin.background.ambientMotion, "window-light");

  const lab = await compileOne("The pressure diagram shows why rounded airplane windows avoid stress at corners.", {
    background_location: "engineering-lab",
    background_variant: "day",
    ambient_motion: "chart-wiggle",
    visual_event: "metaphor-cutaway",
    cutaway_label: "STRESS FINDS CORNERS",
  });
  assert.equal(lab.background.location, "engineering-lab");
  assert.equal(lab.visualEvent.type, "metaphor-cutaway");
});

test("stale generic airplane-window plans get corrected to dynamic story backgrounds", async () => {
  const cabin = await compileOne("I got the airplane window seat and I am leaning toward the cabin window.", {
    background_location: "classroom",
    background_variant: "normal",
    ambient_motion: "none",
  });
  assert.equal(cabin.background.location, "airplane-cabin");
  assert.equal(cabin.background.ambientMotion, "window-light");

  const lab = await compileOne("The airplane window is rounded because cabin pressure concentrates stress around square corners.", {
    background_location: "classroom",
    background_variant: "normal",
    ambient_motion: "none",
  });
  assert.equal(lab.background.location, "engineering-lab");
  assert.equal(lab.background.ambientMotion, "chart-wiggle");
});

test("background router does not misfire on unrelated idioms", async () => {
  const data = await compileOne(
    "This window of opportunity closes if we cut corners or use brute force, so let's plan carefully.",
    { background_location: "living-room", background_variant: "day", ambient_motion: "subtle-parallax" },
  );
  assert.equal(data.background.location, "living-room");
  assert.equal(data.background.ambientMotion, "subtle-parallax");
});

test("long cartoon episodes cannot remain in one visible background", async () => {
  const h = await harness();
  const scenes = Array.from({ length: 13 }, (_, scene_index) => ({
    scene_index,
    point: scene_index === 12 ? "payoff resolves opening" : `beat ${scene_index}`,
    narration: `Ordinary living room dialogue beat number ${scene_index}.`,
    speaker: scene_index % 2 === 0 ? "host" : "buddy",
    emotion: "neutral",
  }));
  const planScenes = scenes.map((scene) => directedScene(scene.scene_index, {
    background_location: "living-room",
    background_variant: "day",
    visual_event: "reaction-pop",
  }));
  const script = await putScript(h, scenes);
  const plan = await putPlan(h, planScenes);

  await assert.rejects(
    () => h.runner.run(makeCartoonSceneCompilerWorker(), [plan.artifact_id, script.artifact_id, h.cast.artifact_id]),
    /Long cartoon episodes require at least two distinct visible environments/,
  );
});
