/**
 * Cartoon thumbnail worker, and the degradation it is allowed to do.
 *
 * The rule under test: creative artwork comes from the image model, actual
 * typography comes from long-compose, and image-generation failure degrades
 * visibly instead of silently masquerading as a successful custom thumbnail.
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
  mode: "cartoon" as const,
  text: "DON'T OPEN IT",
  emphasis: "OPEN IT",
  art_prompt:
    "Create a 16:9 long-form YouTube thumbnail in the channel's clean recurring 2D cartoon style. " +
    "Show one large frightened recurring character on the right recoiling from an open school locker emitting a strong warm glow. " +
    "Keep the left side deliberately quiet for typography. Thick dark outlines, simple readable shapes, expressive face, strong silhouette, controlled saturated colours. " +
    "Do not render words, letters, captions, signs, logos, arrows, circles, UI labels, or watermarks.",
  accent: "#FFD34D",
  visual_hook: "A frightened student discovers something impossible glowing inside an open locker.",
  character_ids: ["pilot"],
  preferred_text_side: "left" as const,
  rationale: "The reaction plus unexplained glowing locker forms one readable visual question at small size.",
  alternatives: ["WHAT'S INSIDE?", "IT WAS LOCKED"],
};

interface ThumbPayload {
  thumbnail_uri: string;
  media_type: string;
  width: number;
  height: number;
  text: string;
  emphasis?: string;
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
        transformation: "cartoon_thumbnail_designer",
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

test("composites deterministic text over generated cartoon artwork", async () => {
  const h = await harness();
  const out = await run(h);

  assert.deepEqual(h.images!.prompts, [BRIEF.art_prompt]);

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.accent, BRIEF.accent);
  assert.equal(sent.emphasis, BRIEF.emphasis);
  assert.ok(sent.image, "the generated cartoon artwork should reach the renderer");

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

test("artwork generation failure degrades to a renderer background instead of failing the run", async () => {
  const h = await harness({ images: new FakeImageProvider(() => true) });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.equal(out.text, BRIEF.text, "the deterministic text still gets burned in");
  assert.equal(
    h.renderer.thumbnailRequests[0]!.image,
    undefined,
    "no image should be sent when artwork generation failed",
  );
});

test("a degraded thumbnail records the attempted art prompt", async () => {
  const h = await harness({ images: new FakeImageProvider(() => true) });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.equal(out.background_query, BRIEF.art_prompt.slice(0, 120));
});

test("with no image provider configured at all, it still produces a measurable degraded thumbnail", async () => {
  const h = await harness({ images: null });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.match(out.thumbnail_uri, /^blob:\/\/sha256:/);
});

test("a renderer outage does fail the node — there is nothing to degrade to", async () => {
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
  assert.doesNotThrow(() =>
    h.registry.validate("thumbnail", h.registry.resolveVersion("thumbnail"), out),
  );
});

test("an identical brief produces an identical artifact id", async () => {
  const a = await harness();
  const b = await harness();
  const first = await a.runner.run(makeThumbnailWorker(), [a.brief.artifact_id]);
  const second = await b.runner.run(makeThumbnailWorker(), [b.brief.artifact_id]);

  assert.equal(first.artifact.artifact_id, second.artifact.artifact_id);
});

test("the emphasised phrase reaches the renderer, not just the text", async () => {
  const h = await harness();
  await run(h);

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.emphasis, BRIEF.emphasis);
});

test("a cartoon brief without emphasis still renders", async () => {
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
  void _dropped;
  const brief = (
    await store.put({
      schema_id: "thumbnail_brief",
      payload: withoutEmphasis,
      produced_by: {
        transformation: "cartoon_thumbnail_designer", version: "1", run_id: "t", provider: null,
      },
    })
  ).artifact;

  const out = await runner.run(makeThumbnailWorker(), [brief.artifact_id]);
  assert.equal((out.artifact.payload as ThumbPayload).text, BRIEF.text);
  assert.equal(renderer.thumbnailRequests[0]!.emphasis, undefined);
});
