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

type EnvironmentTuple = [string, string];

function silent() {
  return { log: () => { }, warn: () => { }, error: () => { } };
}

async function harness(handler: FakeHandler) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-planner-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider(handler);
  const providers = new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider });
  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: silent(), blobs: new MemoryBlobStore() });
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  return { store, runLog, provider, runner, agents };
}

function scriptPayload(sceneCount = 13) {
  return {
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      scene_index: index,
      point: `action=Host handles lateness beat ${index}; function=${index === 0 ? "opening_problem" : index === sceneCount - 1 ? "payoff_resolution" : "routine_escalation"}; value=viewer sees the routine move`,
      narration: index < 3
        ? "The alarm says we are already pretending."
        : index < 7
          ? "The coffee, keys, and calendar all disagree with the plan."
          : "The route map makes the fantasy schedule collapse.",
      speaker: index % 2 === 0 ? "host" : "buddy",
      emotion: index % 2 === 0 ? "surprised" : "neutral",
    })),
    word_count: 130,
  };
}

const CAST_PAYLOAD = {
  characters: [
    { character_id: "host", name: "Host", voice_id: "voice-host", rig: "pilot" },
    { character_id: "buddy", name: "Buddy", voice_id: "voice-buddy", rig: "pilot-2" },
  ],
  default_voice_id: "voice-host",
};

function planScene(index: number, location: string, variant: string) {
  return {
    scene_index: index,
    template_category: "cartoon",
    background_location: location,
    background_variant: variant,
    background_tone: "neutral",
    framing: index === 0
      ? "establishing"
      : index % 4 === 1
        ? "speaker-closeup"
        : index % 4 === 2
          ? "listener-closeup"
          : index % 4 === 3
            ? "prop-insert"
            : "two-shot",
    camera_motion: index % 4 === 2 ? "push-in" : "static",
    listener_actor_id: index % 2 === 0 ? "buddy" : "host",
    speaker_emotion: index % 2 === 0 ? "surprised" : "neutral",
    speaker_gesture: index % 3 === 0 ? "hands-open" : "idle",
    speaker_gaze_target: "auto",
    listener_emotion: "skeptical",
    listener_gesture: "idle",
    listener_gaze_target: "auto",
    visual_event: index % 6 === 4 ? "reaction-pop" : "none",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: "",
    primary_prop: index < 4 ? "clock" : index < 8 ? "keys" : "route-map",
    prop_state: index < 4 ? "running-late" : index < 8 ? "missing" : "traffic-red",
    prop_motion: index % 3 === 0 ? "pulse" : "none",
    foreground_action: "The visible routine object carries the beat",
  };
}

function planPayload(locations: EnvironmentTuple[]) {
  return {
    scenes: locations.map(([location, variant], index) => planScene(index, location, variant)),
  };
}

test("cartoon_visual_planner no longer rejects a long one-room visual plan", async () => {
  // Product direction: storytelling and concept explanation over cinematic
  // environment/shot variety. A 13-scene episode that legitimately stays in
  // one room (e.g. because the demonstration doesn't need a location change)
  // now stores on the first attempt instead of being forced to retry.
  const h = await harness(() => ({
    payload: planPayload(Array.from({ length: 13 }, () => ["living-room", "day"] as EnvironmentTuple)),
    confidence: { overall: 0.9 },
  }));

  const script = await h.store.put({
    schema_id: "script",
    schema_version: "1.2.0",
    payload: scriptPayload(),
    produced_by: { transformation: "dialogue_script_writer", version: "6", run_id: "run_seed", provider: null },
  });
  const cast = await h.store.put({
    schema_id: "cast_roster",
    schema_version: "1.0.0",
    payload: CAST_PAYLOAD,
    produced_by: { transformation: "human", version: "1", run_id: "run_seed", provider: null },
  });

  const out = await h.runner.run(h.agents.get("cartoon_visual_planner")!, [script.artifact.artifact_id, cast.artifact.artifact_id]);

  assert.equal(out.attempts, 1);
  assert.equal(h.provider.calls.length, 1);

  const records = await h.runLog.all();
  assert.deepEqual(records.map((record) => record.status), ["ok"]);
});
