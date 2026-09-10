import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { FsBlobStore, MemoryBlobStore, BlobStoreError, isBlobUri } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeSpeechProvider } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { makeVoiceWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });
const SCRIPT = {
  scenes: [
    { scene_index: 0, act_index: 0, point: "open", narration: "Chile is absurdly long." },
    { scene_index: 1, act_index: 0, point: "why", narration: "The Andes drew the border." },
    { scene_index: 2, act_index: 1, point: "payoff", narration: "It is rock, not politics." },
  ],
};

async function harness(speech = new FakeSpeechProvider()) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-media-")), registry);
  const blobs = new MemoryBlobStore();
  const runner = new Runner({
    store,
    registry,
    prompts,
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs,
    media: { speech },
  });
  const seed = async (schemaId: string, payload: unknown, producer: string) =>
    (await store.put({
      schema_id: schemaId,
      payload,
      produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
    })).artifact;
  return { store, blobs, speech, runner, seed };
}

test("blobs are content-addressed, immutable, and deduplicated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vidgen-blobs-"));
  const blobs = await FsBlobStore.open(root);
  const bytes = new TextEncoder().encode("hello andes");

  const a = await blobs.put(bytes, { role: "audio", media_type: "audio/mpeg" });
  const b = await blobs.put(bytes, { role: "thumbnail", media_type: "image/png" });

  assert.ok(isBlobUri(a.uri));
  assert.equal(a.uri, b.uri);
  assert.equal(a.bytes, bytes.byteLength);
  assert.deepEqual(await blobs.get(a.uri), bytes);
  assert.equal((await blobs.size()).count, 1);
});

test("a tampered blob is detected on read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vidgen-blobs-"));
  const blobs = await FsBlobStore.open(root);
  const ref = await blobs.put(new TextEncoder().encode("original"), { role: "audio" });
  const hex = ref.uri.slice("blob://sha256:".length);
  await writeFile(path.join(root, "blobs", hex.slice(0, 2), hex), "tampered", "utf8");
  await assert.rejects(() => blobs.get(ref.uri), /content hash mismatch/);
});

test("a missing blob fails loudly", async () => {
  const blobs = new MemoryBlobStore();
  await assert.rejects(() => blobs.get(`blob://sha256:${"0".repeat(64)}`), BlobStoreError);
});

test("voice worker produces exactly one clip per approved narration scene", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const out = await h.runner.run(makeVoiceWorker({ voiceId: "voice-1" }), [script.artifact_id]);
  const payload = out.artifact.payload as {
    voice_id: string;
    clips: Array<{ scene_index: number; audio_uri: string; alignment_uri?: string }>;
    total_duration_sec: number;
  };

  assert.equal(payload.voice_id, "voice-1");
  assert.deepEqual(payload.clips.map((clip) => clip.scene_index), [0, 1, 2]);
  assert.ok(payload.total_duration_sec > 0);
  const owned = new Set((out.artifact.blobs ?? []).map((blob) => blob.uri));
  assert.equal(owned.size, 6);
  for (const clip of payload.clips) {
    assert.ok(owned.has(clip.audio_uri));
    assert.ok(await h.blobs.has(clip.audio_uri));
  }
});

test("voice worker passes neighbouring narration for prosody continuity", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  await h.runner.run(makeVoiceWorker({ voiceId: "voice-1" }), [script.artifact_id]);
  const byText = new Map(h.speech.calls.map((call) => [call.text, call]));

  assert.equal(byText.get("Chile is absurdly long.")!.prev, undefined);
  assert.equal(byText.get("Chile is absurdly long.")!.next, "The Andes drew the border.");
  assert.equal(byText.get("The Andes drew the border.")!.prev, "Chile is absurdly long.");
  assert.equal(byText.get("The Andes drew the border.")!.next, "It is rock, not politics.");
  assert.equal(byText.get("It is rock, not politics.")!.next, undefined);
});

test("voice worker deduplicates the same script deterministically", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const worker = makeVoiceWorker({ voiceId: "voice-1" });
  const first = await h.runner.run(worker, [script.artifact_id]);
  const second = await h.runner.run(worker, [script.artifact_id]);
  assert.equal(second.deduped, true);
  assert.equal(second.artifact.artifact_id, first.artifact.artifact_id);
});
