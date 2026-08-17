/**
 * Thumbnail worker, and the degradation it is allowed to do.
 *
 * The rule under test: a thumbnail must never fail a run, but a degraded
 * thumbnail must never look like a good one. Every fallback has to end up in
 * the artifact, because "the stock lookup quietly failed and we shipped a
 * gradient" is exactly the kind of invisible quality loss that makes
 * click-through impossible to reason about later.
 */

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
import { FakeRenderer, FakeImageProvider } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { makeThumbnailWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

const BRIEF = {
  // A hook, not a title — two words, well inside the 30-char cap.
  text: "Ancient Life",
  emphasis: "Ancient",
  background_query: "ancient stone map carved in rock",
  accent: "#FFD34D",
  rationale: "The subject is what people stop for; the rest is context.",
  alternatives: ["The 400-Year Mistake"],
};

interface ThumbPayload {
  thumbnail_uri: string;
  media_type: string;
  width: number;
  height: number;
  text: string;
  background: "supplied" | "gradient";
  background_query?: string;
  bytes?: number;
}

async function harness(opts: {
  renderer?: FakeRenderer;
  images?: FakeImageProvider | null;
} = {}) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-thumb-")),
    registry,
  );
  const blobs = new MemoryBlobStore();
  const renderer = opts.renderer ?? new FakeRenderer();
  const images = opts.images === null ? undefined : (opts.images ?? new FakeImageProvider());

  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs,
    media: { renderer, ...(images ? { images } : {}) },
  });

  const brief = (
    await store.put({
      schema_id: "thumbnail_brief",
      payload: BRIEF,
      produced_by: {
        transformation: "thumbnail_designer",
        version: "1",
        run_id: "t",
        provider: null,
      },
    })
  ).artifact;

  return { registry, store, blobs, runner, renderer, images, brief };
}

const run = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.runner.run(makeThumbnailWorker(), [h.brief.artifact_id])).artifact
    .payload as ThumbPayload;

test("composites the brief's text over a fetched stock background", async () => {
  const h = await harness();
  const out = await run(h);

  // The background was searched for using the brief's query, not the text.
  assert.deepEqual(h.images!.prompts, [BRIEF.background_query]);

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.accent, BRIEF.accent);
  assert.ok(sent.image, "the fetched photo should reach the renderer");

  assert.equal(out.background, "supplied");
  assert.equal(out.text, BRIEF.text);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
  assert.match(out.thumbnail_uri, /^blob:\/\/sha256:[0-9a-f]{64}$/);
});

test("the rendered bytes are actually stored and retrievable", async () => {
  const h = await harness();
  const out = await run(h);

  const bytes = await h.blobs.get(out.thumbnail_uri);
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes.byteLength, out.bytes);
});

test("a stock lookup failure degrades to a gradient instead of failing the run", async () => {
  // Publishing without the designed thumbnail is bad; not publishing is worse.
  const h = await harness({ images: new FakeImageProvider(() => true) });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.equal(out.text, BRIEF.text, "the text still gets burned in");
  assert.equal(
    h.renderer.thumbnailRequests[0]!.image,
    undefined,
    "no image should be sent when the lookup failed",
  );
});

test("a degraded thumbnail says so in the artifact, not just in the log", async () => {
  const h = await harness({ images: new FakeImageProvider(() => true) });
  const out = await run(h);

  // The whole point: downstream can tell a gradient from a photo without
  // reading logs that have long since rotated away.
  assert.equal(out.background, "gradient");
  assert.equal(out.background_query, BRIEF.background_query);
});

test("with no image provider configured at all, it still produces a thumbnail", async () => {
  const h = await harness({ images: null });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.match(out.thumbnail_uri, /^blob:\/\/sha256:/);
});

test("a renderer outage does fail the node — there is nothing to degrade to", async () => {
  // The distinction that matters: a missing *background* is recoverable, a
  // missing *renderer* is not. Inventing an image here would mean publishing
  // something nobody designed.
  const h = await harness({ renderer: new FakeRenderer("compose is down") });
  await assert.rejects(() => run(h), /compose is down/);

  assert.equal(
    (await h.store.index()).filter((r) => r.schema_id === "thumbnail").length,
    0,
    "a failed render must not leave a thumbnail artifact behind",
  );
});

test("the artifact validates against the registry schema", async () => {
  const h = await harness();
  const out = await run(h);
  // Resolved, not hardcoded: a MINOR schema bump must not break this test —
  // that trap has already been hit once in this repo.
  assert.doesNotThrow(() =>
    h.registry.validate("thumbnail", h.registry.resolveVersion("thumbnail"), out),
  );
});

test("an identical brief produces an identical artifact id", async () => {
  // Content addressing: same reasoning in, same artifact out.
  const a = await harness();
  const b = await harness();
  const first = await a.runner.run(makeThumbnailWorker(), [a.brief.artifact_id]);
  const second = await b.runner.run(makeThumbnailWorker(), [b.brief.artifact_id]);

  assert.equal(first.artifact.artifact_id, second.artifact.artifact_id);
});

test("the emphasised phrase reaches the renderer, not just the text", async () => {
  // Without this the renderer has no focal point and sets everything in one
  // colour — which is the flat look the redesign existed to remove.
  const h = await harness();
  await run(h);

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.emphasis, "Ancient");
});

test("a brief without emphasis still renders", async () => {
  // thumbnail_brief@1.0.0 artifacts predate the field, and emphasis is optional
  // in 1.1.0 — neither may break the worker.
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-thumb-noemph-")),
    registry,
  );
  const renderer = new FakeRenderer();
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
    media: { renderer, images: new FakeImageProvider() },
  });

  const { emphasis: _dropped, ...withoutEmphasis } = BRIEF;
  const brief = (
    await store.put({
      schema_id: "thumbnail_brief",
      payload: withoutEmphasis,
      produced_by: {
        transformation: "thumbnail_designer", version: "1", run_id: "t", provider: null,
      },
    })
  ).artifact;

  const out = await runner.run(makeThumbnailWorker(), [brief.artifact_id]);
  assert.equal((out.artifact.payload as ThumbPayload).text, BRIEF.text);
  assert.equal(renderer.thumbnailRequests[0]!.emphasis, undefined);
});
