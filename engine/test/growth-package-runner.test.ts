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
import { FakeProvider } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { loadAgentDefs } from "../src/catalog.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function inconsistentPackage() {
  return {
    premise: "A hotel guest discovers why a fire alarm keeps sounding in the middle of the night.",
    target_audience: "Adults who enjoy contained mystery dramas",
    curiosity_gap: "Why the alarm keeps sounding when nobody can find a fire",
    emotional_engine: "confusion to suspicion to a concrete hidden cause",
    selected_title: "A paraphrase the model should not be trusted to repeat",
    selected_title_family: "curiosity",
    selected_thumbnail_concept: "Another paraphrase instead of the selected family member",
    selected_thumbnail_family: "reversal",
    opening_visual: "A sleepy hotel guest standing beneath a flashing alarm in an otherwise calm corridor.",
    opening_line: "The alarm went off again, but this time there was no smoke anywhere.",
    first_30_seconds: {
      promise: "The episode will reveal what is really triggering the repeated alarm.",
      zero_to_five: "Open on the third unexplained alarm while guests spill into the corridor.",
      five_to_fifteen: "Staff reset the system, but one sensor immediately reports the same fault again.",
      fifteen_to_thirty: "A maintenance worker notices the alarm only returns after one specific room changes temperature.",
    },
    variants: [
      {
        family: "curiosity",
        title: "Why Did the Hotel Alarm Keep Going Off?",
        thumbnail_concept: "Confused guest under a flashing alarm in an empty corridor",
        click_reason: "The repeated alarm creates a concrete unanswered question.",
      },
      {
        family: "conflict",
        title: "The Hotel Said There Was No Fire",
        thumbnail_concept: "Guest confronting a dismissive night manager beside the alarm panel",
        click_reason: "The official explanation conflicts with what the guest keeps experiencing.",
      },
      {
        family: "reversal",
        title: "The Fire Alarm Was Warning Them About Something Else",
        thumbnail_concept: "Maintenance worker finding a hidden fault behind a hotel wall panel",
        click_reason: "The apparent false alarm becomes evidence of a different hidden problem.",
      },
    ],
    scores: { clickability: 0.88, story_potential: 0.86, audience_size: 0.84 },
    selection_rationale: "The curiosity title with the reversal thumbnail creates the strongest coherent open loop.",
    next_video_bridge: "Another hotel mystery began with a door that unlocked itself only after midnight.",
  };
}

test("real runner stores a canonical package on the first attempt despite duplicated-string drift", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-package-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider(() => ({
    payload: inconsistentPackage(),
    confidence: { overall: 0.91 },
  }));
  const providers = new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider });
  const runner = new Runner({
    store,
    registry,
    prompts,
    providers,
    runLog,
    blobs: new MemoryBlobStore(),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));

  const intent = await store.put({
    schema_id: "intent",
    payload: {
      brief: "A hotel guest investigates a repeating fire alarm with no visible fire.",
      target_duration_sec: 180,
      genre: "drama",
      image_style: "flat_comic_expressive",
    },
    produced_by: { transformation: "human", version: "1", run_id: "run_seed", provider: null },
  });
  const insights = await store.put({
    schema_id: "channel_insights",
    payload: {
      sample_size: 0,
      confidence_note: "Nothing measured yet; no guidance can be supported.",
      guidance: [],
      editorial_memory: [],
    },
    produced_by: { transformation: "channel_strategist", version: "2", run_id: "run_seed", provider: null },
  });

  const out = await runner.run(
    agents.get("growth_packager")!,
    [intent.artifact.artifact_id, insights.artifact.artifact_id],
    { runId: "run_package_contract", nodeId: "package", graphId: "illustrated_story@7" },
  );
  const payload = out.artifact.payload as ReturnType<typeof inconsistentPackage>;

  assert.equal(out.attempts, 1, "deterministic canonicalization must not spend another model call");
  assert.equal(provider.calls.length, 1);
  assert.equal(payload.selected_title, payload.variants[0]!.title);
  assert.equal(payload.selected_thumbnail_concept, payload.variants[2]!.thumbnail_concept);
  assert.equal(payload.selected_title_family, "curiosity");
  assert.equal(payload.selected_thumbnail_family, "reversal");

  const records = await runLog.all();
  assert.deepEqual(records.map((record) => record.status), ["ok"]);
});
