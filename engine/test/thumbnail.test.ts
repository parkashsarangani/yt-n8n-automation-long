/**
 * Thumbnail worker: best-effort artwork, gradient fallback.
 *
 * Typography comes from long-compose; artwork comes from the image model
 * when one is configured and the brief has a usable prompt. Neither a failed
 * generation nor a missing provider blocks the run — they degrade to the
 * renderer's gradient background with a warning, so a thumbnail always ships.
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
  text: "DON'T OPEN IT",
  emphasis: "OPEN IT",
  background_query: "a glowing school locker at night",
  accent: "#FFD34D",
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
  brief?: Partial<typeof BRIEF>;
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
      schema_version: "1.1.0",
      payload: { ...BRIEF, ...(opts.brief ?? {}) },
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

test("composites deterministic text over generated artwork", async () => {
  const h = await harness();
  const out = await run(h);

  assert.equal(h.images!.prompts.length, 1);
  assert.ok(h.images!.prompts[0]!.includes(BRIEF.background_query));
  assert.ok(h.images!.prompts[0]!.includes("Quiet Signal editorial illustration"));

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.accent, BRIEF.accent);
  assert.equal(sent.emphasis, BRIEF.emphasis);
  assert.ok(sent.image, "the generated artwork should reach the renderer");

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

test("artwork generation failure degrades to a gradient instead of blocking the run", async () => {
  const h = await harness({ images: new FakeImageProvider(() => true) });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.equal(h.renderer.thumbnailRequests[0]!.image, undefined);
});

test("no image provider degrades to a gradient instead of blocking the run", async () => {
  const h = await harness({ images: null });
  const out = await run(h);

  assert.equal(out.background, "gradient");
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

test("a brief without emphasis still renders", async () => {
  const h = await harness({ brief: { emphasis: undefined } });
  const out = await run(h);

  assert.equal(out.text, BRIEF.text);
  assert.equal(h.renderer.thumbnailRequests[0]!.emphasis, undefined);
});

test("shared art direction asks for one legible face, not a multi-person tableau", async () => {
  // vidIQ's 2026 breakout-thumbnail study: 69% of breakout thumbnails used a
  // human face (80% of the biggest overperformers), 89% used a face or
  // high-contrast color, and only 1 in 20 used an exaggerated expression.
  // The shared artwork now doubles as the production thumbnail, so its
  // composition must actually work as one -- a two-person profile-view scene
  // has no single focal point.
  const { CHANNEL_ART_DIRECTION } = await import("../src/visual-identity.ts");
  assert.match(CHANNEL_ART_DIRECTION, /\bone\b.*adult/i);
  assert.match(CHANNEL_ART_DIRECTION, /genuine.*expression/i);
  assert.match(CHANNEL_ART_DIRECTION, /never (?:profile|manufactured)/i);
});
