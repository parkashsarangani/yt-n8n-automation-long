import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SchemaRegistry, SchemaValidationError } from "../src/registry.ts";
import { FsArtifactStore, ArtifactStoreError } from "../src/store.ts";
import { computeArtifactId, type ProducedBy } from "../src/artifact.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(HERE, "..", "schemas");

const BY: ProducedBy = {
  transformation: "story_architect",
  version: "1",
  run_id: "run_test",
  provider: "test/fake",
};

const STORY = {
  topic: "Why Chile is so incredibly long",
  title: "The Country That Refused To Stop",
  hook: "Four thousand kilometres of coastline and almost no width.",
  acts: [
    { act_index: 0, act_title: "The shape", premise: "Establish the absurd geometry of it.", target_words: 300 },
    { act_index: 1, act_title: "The spine", premise: "The Andes drew the border first.", target_words: 300 },
    { act_index: 2, act_title: "The reach", premise: "Conquest stretched it further.", target_words: 300 },
  ],
  payoff: "The shape is not politics. It is rock.",
  outro_line: "Send this to someone who thinks maps are boring.",
};

async function freshStore() {
  const registry = await SchemaRegistry.load(SCHEMA_DIR);
  const root = await mkdtemp(path.join(tmpdir(), "amos-store-"));
  return { store: await FsArtifactStore.open(root, registry), root };
}

test("put then get round-trips and assigns a content address", async () => {
  const { store } = await freshStore();
  const { artifact, deduped } = await store.put({
    schema_id: "story",
    payload: STORY,
    produced_by: BY,
  });

  assert.equal(deduped, false);
  assert.equal(artifact.schema_version, "1.0.0"); // resolved from the registry
  assert.match(artifact.artifact_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(artifact.artifact_id, computeArtifactId("story", "1.0.0", STORY));

  const loaded = await store.require(artifact.artifact_id, { schema_id: "story", range: "^1" });
  assert.deepEqual(loaded.payload, STORY);
});

test("identical content dedups to the same artifact", async () => {
  const { store } = await freshStore();
  const first = await store.put({ schema_id: "story", payload: STORY, produced_by: BY });
  const second = await store.put({
    schema_id: "story",
    payload: structuredClone(STORY),
    produced_by: { ...BY, run_id: "run_other" },
  });

  assert.equal(second.deduped, true);
  assert.equal(second.artifact.artifact_id, first.artifact.artifact_id);
  // Immutability: the first envelope wins; the second production is recorded in
  // the run log (RFC 0006), not by rewriting the artifact.
  assert.equal(second.artifact.produced_by.run_id, "run_test");
});

test("identity ignores producer, parents, confidence and time", async () => {
  const { store } = await freshStore();
  const a = await store.put({ schema_id: "story", payload: STORY, produced_by: BY });
  const b = await store.put({
    schema_id: "story",
    payload: STORY,
    produced_by: { ...BY, transformation: "story_architect", version: "99", run_id: "r2" },
    confidence: { overall: 0.1 },
  });
  assert.equal(a.artifact.artifact_id, b.artifact.artifact_id);
});

test("a payload that fails its schema never becomes an artifact", async () => {
  const { store } = await freshStore();
  await assert.rejects(
    () => store.put({ schema_id: "story", payload: { ...STORY, acts: [] }, produced_by: BY }),
    SchemaValidationError,
  );
  assert.deepEqual(await store.index(), []);
});

test("producer allowlist is enforced on write", async () => {
  const { store } = await freshStore();
  await assert.rejects(
    () =>
      store.put({
        schema_id: "story",
        payload: STORY,
        produced_by: { ...BY, transformation: "publisher" },
      }),
    /may not produce/,
  );
});

test("declared parents must already exist", async () => {
  const { store } = await freshStore();
  const missing = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    () => store.put({ schema_id: "story", payload: STORY, produced_by: BY, parents: [missing] }),
    ArtifactStoreError,
  );
});

test("reading with the wrong expectation fails at the boundary", async () => {
  const { store } = await freshStore();
  const { artifact } = await store.put({ schema_id: "story", payload: STORY, produced_by: BY });

  await assert.rejects(
    () => store.require(artifact.artifact_id, { schema_id: "script" }),
    /expected schema "script"/,
  );
  await assert.rejects(
    () => store.require(artifact.artifact_id, { schema_id: "story", range: "^2" }),
    /requires "\^2"/,
  );
});

test("tampering with a stored artifact is detected on read", async () => {
  const { store, root } = await freshStore();
  const { artifact } = await store.put({ schema_id: "story", payload: STORY, produced_by: BY });

  const hex = artifact.artifact_id.slice("sha256:".length);
  const file = path.join(root, "artifacts", hex.slice(0, 2), `${hex}.json`);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  onDisk.payload.title = "Quietly Edited Title";
  await writeFile(file, JSON.stringify(onDisk), "utf8");

  await assert.rejects(() => store.get(artifact.artifact_id), /content hash mismatch/);
});

test("lineage walks transitive ancestors", async () => {
  const { store } = await freshStore();
  const intent = await store.put({
    schema_id: "intent",
    payload: { brief: "a documentary about the world's strangest airports" },
    produced_by: { transformation: "human", version: "1", run_id: "run_a", provider: null },
  });
  const story = await store.put({
    schema_id: "story",
    payload: STORY,
    produced_by: BY,
    parents: [intent.artifact.artifact_id],
  });
  const script = await store.put({
    schema_id: "script",
    payload: { scenes: [{ scene_index: 0, point: "open", narration: "Chile is very long." }] },
    produced_by: { ...BY, transformation: "script_writer" },
    parents: [story.artifact.artifact_id],
  });

  const ancestors = await store.lineage(script.artifact.artifact_id);
  assert.deepEqual(
    ancestors.map((a) => a.schema_id),
    ["story", "intent"],
  );
});

test("index records one row per stored artifact and survives a rebuild", async () => {
  const { store } = await freshStore();
  await store.put({
    schema_id: "story",
    payload: STORY,
    produced_by: BY,
    labels: { lineage_id: "lin_1", variant: "a" },
  });
  await store.put({
    schema_id: "story",
    payload: { ...STORY, title: "A Different Title Entirely" },
    produced_by: BY,
    labels: { lineage_id: "lin_1", variant: "b" },
  });

  const rows = await store.index();
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.lineage_id)), new Set(["lin_1"]));

  const rebuilt = await store.reindex();
  assert.equal(rebuilt, 2);
  assert.equal((await store.index()).length, 2);
});
