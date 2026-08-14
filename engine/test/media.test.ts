import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { FsBlobStore, MemoryBlobStore, BlobStoreError, isBlobUri } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeSpeechProvider, FakeImageProvider } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { makeVoiceWorker, makeAssetWorker, buildPrompt } from "../src/workers/index.ts";
import type { Artifact } from "../src/artifact.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });

const SCRIPT = {
  scenes: [
    { scene_index: 0, act_index: 0, point: "open", narration: "Chile is absurdly long." },
    { scene_index: 1, act_index: 0, point: "why", narration: "The Andes drew the border." },
    { scene_index: 2, act_index: 1, point: "payoff", narration: "It is rock, not politics." },
  ],
};

const PLAN = {
  scenes: [
    {
      scene_index: 0,
      search_terms: ["aerial coastline", "andes ridge", "desert highway"],
      visual_style: "vivid documentary",
      fallback_terms: ["mountains", "coast"],
    },
    {
      scene_index: 1,
      search_terms: ["glacier valley", "stone border marker", "map table"],
      visual_style: "vivid documentary",
      fallback_terms: ["snow peaks", "valley"],
    },
  ],
};

async function harness(opts: { speech?: FakeSpeechProvider; images?: FakeImageProvider } = {}) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-media-")), registry);
  const blobs = new MemoryBlobStore();
  const speech = opts.speech ?? new FakeSpeechProvider();
  const images = opts.images ?? new FakeImageProvider();
  const runner = new Runner({
    store,
    registry,
    prompts,
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs,
    media: { speech, images },
  });
  const seed = async (schemaId: string, payload: unknown, producer: string) =>
    (
      await store.put({
        schema_id: schemaId,
        payload,
        produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
      })
    ).artifact;
  return { store, blobs, speech, images, runner, seed };
}

// -- blob store ---------------------------------------------------------

test("blobs are content-addressed, immutable, and dedup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vidgen-blobs-"));
  const blobs = await FsBlobStore.open(root);
  const bytes = new TextEncoder().encode("hello andes");

  const a = await blobs.put(bytes, { role: "audio", media_type: "audio/mpeg" });
  const b = await blobs.put(bytes, { role: "image", media_type: "image/png" });

  assert.ok(isBlobUri(a.uri));
  assert.equal(a.uri, b.uri); // same bytes, one copy
  assert.equal(a.bytes, bytes.byteLength);
  assert.equal(a.media_type, "audio/mpeg");
  assert.deepEqual(await blobs.get(a.uri), bytes);
  assert.equal((await blobs.size()).count, 1);
});

test("a tampered blob is detected on read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vidgen-blobs-"));
  const blobs = await FsBlobStore.open(root);
  const ref = await blobs.put(new TextEncoder().encode("original"), { role: "image" });

  const hex = ref.uri.slice("blob://sha256:".length);
  await writeFile(path.join(root, "blobs", hex.slice(0, 2), hex), "tampered", "utf8");

  await assert.rejects(() => blobs.get(ref.uri), /content hash mismatch/);
});

test("a missing blob fails loudly rather than returning nothing", async () => {
  const blobs = new MemoryBlobStore();
  await assert.rejects(
    () => blobs.get(`blob://sha256:${"0".repeat(64)}`),
    BlobStoreError,
  );
});

// -- voice worker -------------------------------------------------------

test("voice worker produces one clip per scene and owns its blobs", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const worker = makeVoiceWorker({ voiceId: "voice-1" });

  const out = await h.runner.run(worker, [script.artifact_id]);
  const payload = out.artifact.payload as {
    voice_id: string;
    clips: Array<{ scene_index: number; audio_uri: string; alignment_uri?: string }>;
    total_duration_sec: number;
  };

  assert.equal(payload.voice_id, "voice-1");
  assert.deepEqual(payload.clips.map((c) => c.scene_index), [0, 1, 2]);
  assert.ok(payload.total_duration_sec > 0);
  assert.equal(out.artifact.produced_by.provider, null); // a worker, not an agent

  // The envelope owns every blob; the payload only references them, so the
  // artifact stays small and hashable (RFC 0002).
  const envelopeUris = new Set((out.artifact.blobs ?? []).map((b) => b.uri));
  assert.equal(envelopeUris.size, 6); // 3 audio + 3 alignment
  for (const clip of payload.clips) {
    assert.ok(envelopeUris.has(clip.audio_uri));
    assert.ok(await h.blobs.has(clip.audio_uri));
  }
});

test("voice worker passes neighbouring narration for prosody continuity", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  await h.runner.run(makeVoiceWorker({ voiceId: "voice-1" }), [script.artifact_id]);

  const byText = new Map(h.speech.calls.map((c) => [c.text, c]));
  const first = byText.get("Chile is absurdly long.")!;
  const middle = byText.get("The Andes drew the border.")!;
  const last = byText.get("It is rock, not politics.")!;

  assert.equal(first.prev, undefined); // nothing before the first scene
  assert.equal(first.next, "The Andes drew the border.");
  assert.equal(middle.prev, "Chile is absurdly long.");
  assert.equal(middle.next, "It is rock, not politics.");
  assert.equal(last.next, undefined); // nothing after the last
});

test("voice worker is deterministic: the same script dedups to one artifact", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const worker = makeVoiceWorker({ voiceId: "voice-1" });

  const a = await h.runner.run(worker, [script.artifact_id]);
  const b = await h.runner.run(worker, [script.artifact_id]);
  assert.equal(b.deduped, true);
  assert.equal(b.artifact.artifact_id, a.artifact.artifact_id);
});

// -- asset collector ----------------------------------------------------

test("asset worker generates one image per scene from the primary terms", async () => {
  const h = await harness();
  const plan = await h.seed("visual_plan", PLAN, "visual_planner");

  const out = await h.runner.run(makeAssetWorker(), [plan.artifact_id]);
  const payload = out.artifact.payload as {
    scenes: Array<{ scene_index: number; source: string; image_uri?: string }>;
    degraded_count: number;
  };

  assert.deepEqual(payload.scenes.map((s) => s.source), ["primary", "primary"]);
  assert.equal(payload.degraded_count, 0);
  assert.equal((out.artifact.blobs ?? []).length, 2);
  // The prompt carries the terms, the style, and the no-text rule.
  assert.match(h.images.prompts[0]!, /aerial coastline, andes ridge, desert highway/);
  assert.match(h.images.prompts[0]!, /No text, no words/);
});

test("asset worker falls back to the backup terms when the primary fails", async () => {
  const images = new FakeImageProvider((p) => p.includes("aerial coastline"));
  const h = await harness({ images });
  const plan = await h.seed("visual_plan", PLAN, "visual_planner");

  const out = await h.runner.run(makeAssetWorker(), [plan.artifact_id]);
  const payload = out.artifact.payload as {
    scenes: Array<{ scene_index: number; source: string; image_uri?: string }>;
    degraded_count: number;
  };

  assert.equal(payload.scenes[0]!.source, "fallback");
  assert.ok(payload.scenes[0]!.image_uri); // still has a real image
  assert.equal(payload.scenes[1]!.source, "primary");
  assert.equal(payload.degraded_count, 0);
});

test("both rungs failing degrades the scene instead of failing the video", async () => {
  const images = new FakeImageProvider(() => true); // everything fails
  const h = await harness({ images });
  const plan = await h.seed("visual_plan", PLAN, "visual_planner");

  const out = await h.runner.run(makeAssetWorker(), [plan.artifact_id]);
  const payload = out.artifact.payload as {
    scenes: Array<{ source: string; image_uri?: string }>;
    degraded_count: number;
  };

  // The run still produced a usable artifact — this is a quality gauge, not a
  // pipeline failure (RFC 0006 splits the two).
  assert.deepEqual(payload.scenes.map((s) => s.source), ["placeholder", "placeholder"]);
  assert.equal(payload.degraded_count, 2);
  for (const s of payload.scenes) assert.equal(s.image_uri, undefined);
  assert.equal((out.artifact.blobs ?? []).length, 0);
  assert.equal(h.images.prompts.length, 4); // 2 scenes x (primary + fallback)
});

test("identical prompts across scenes cost one blob, not two", async () => {
  const h = await harness();
  const duplicated = {
    scenes: [
      { ...PLAN.scenes[0]!, scene_index: 0 },
      { ...PLAN.scenes[0]!, scene_index: 1 },
    ],
  };
  const plan = await h.seed("visual_plan", duplicated, "visual_planner");
  const out = await h.runner.run(makeAssetWorker(), [plan.artifact_id]);

  const payload = out.artifact.payload as { scenes: Array<{ image_uri: string }> };
  assert.equal(payload.scenes[0]!.image_uri, payload.scenes[1]!.image_uri);
  assert.equal(h.blobs.count, 1); // content-addressed dedup
});

test("a worker without its provider fails clearly", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-nomedia-")), registry);
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
    media: {}, // no speech provider
  });
  const script = (
    await store.put({
      schema_id: "script",
      payload: SCRIPT,
      produced_by: { transformation: "script_writer", version: "1", run_id: "t", provider: null },
    })
  ).artifact;

  await assert.rejects(
    () => runner.run(makeVoiceWorker({ voiceId: "v" }), [script.artifact_id]),
    /requires a speech provider/,
  );
});

test("buildPrompt is a pure function of terms and style", () => {
  const p = buildPrompt(["a", "b"], "moody");
  assert.match(p, /a, b\. moody\./);
  assert.equal(buildPrompt(["a", "b"], "moody"), p);
});
