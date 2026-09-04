/**
 * SEO metadata: the schema contract, and the publish-time limits that decide
 * whether an upload is accepted.
 *
 * The tag tests exist because of a real modelling bug. The YouTube target
 * declared `max_tags: 500`, which reads as "500 tags" and was checked as a
 * count — but YouTube's actual limit is 500 *characters* across all tags
 * combined. The story schema permitted 20 tags of 60 characters, so a legal
 * tag count could be a 1200-character payload that passed validation locally
 * and was rejected at upload, after the video had already been encoded.
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
import { FakePublishTarget } from "../src/providers/fake.ts";
import { YouTubeTarget } from "../src/providers/youtube.ts";
import { Runner } from "../src/runner.ts";
import { makePublishWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

const SEO = {
  title: "Why Chile Is So Absurdly Long (It Is Not Politics)",
  description:
    "Why is Chile so long? The Andes drew the border millions of years before " +
    "any treaty did. Here is how a mountain range decided a country's shape.",
  tags: ["why is chile so long", "chile geography", "andes", "borders", "maps"],
  primary_keyword: "why is chile so long",
  rationale: "Targets the literal question; the narration answers it directly.",
};

async function harness(target = new FakePublishTarget()) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-seo-")),
    registry,
  );
  const blobs = new MemoryBlobStore();
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs,
  });

  const seed = async (schema: string, payload: unknown, producer: string) =>
    (
      await store.put({
        schema_id: schema,
        payload,
        produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
      })
    ).artifact;

  const videoBlob = await blobs.put(new TextEncoder().encode("mp4"), { role: "video" });
  const thumbBlob = await blobs.put(new TextEncoder().encode("png"), { role: "thumbnail" });

  const publishWith = async (seoOverrides: Partial<typeof SEO>) => {
    const video = await seed(
      "rendered_video",
      {
        video_uri: videoBlob.uri,
        media_type: "video/mp4",
        scene_count: 3,
        degraded_scenes: 0,
        duration_sec: 540,
      },
      "render",
    );
    const seo = await seed("seo_metadata", { ...SEO, ...seoOverrides }, "seo_optimizer");
    const thumb = await seed(
      "thumbnail",
      {
        thumbnail_uri: thumbBlob.uri,
        media_type: "image/png",
        width: 1280,
        height: 720,
        text: "It Never Existed",
        background: "supplied",
      },
      "thumbnail",
    );
    // Publish consumes the QA verdict now; these tests are about platform
    // limits, so QA is clean and the tag check under test is publish's own.
    const qa = await seed(
      "qa_report",
      {
        verdict: "pass",
        failed: 0,
        warned: 0,
        checks: [{ id: "images_resolved", status: "pass", message: "all good" }],
      },
      "qa",
    );
    return runner.run(makePublishWorker({ target }), [
      video.artifact_id,
      seo.artifact_id,
      thumb.artifact_id,
      qa.artifact_id,
    ]);
  };

  return { registry, store, target, publishWith };
}

// -- the tag budget -----------------------------------------------------

test("youtube declares the tag budget in characters, not just a tag count", () => {
  const reqs = new YouTubeTarget({ accessToken: "t" }).requirements();
  assert.equal(reqs.max_tag_chars, 500, "the aggregate character limit is the real one");
  assert.ok(
    (reqs.max_tags ?? 0) < 500,
    "max_tags used to be 500, which read as a tag count and was not the limit at all",
  );
});

test("tags within the count but over the character budget are rejected before upload", async () => {
  // 15 tags x 40 chars = 600 characters: a legal count, an illegal payload.
  const h = await harness(
    new FakePublishTarget({ requirements: { max_tags: 30, max_tag_chars: 500 } }),
  );
  const fat = Array.from({ length: 15 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(38)}`);

  await assert.rejects(
    () => h.publishWith({ tags: fat }),
    /tags total 600 characters, .* allows 500/,
  );
  assert.equal(h.target.published.length, 0, "nothing may be uploaded after a rejection");
});

test("tags inside the character budget pass", async () => {
  const h = await harness(
    new FakePublishTarget({ requirements: { max_tags: 30, max_tag_chars: 500 } }),
  );
  const out = await h.publishWith({});
  assert.ok((out.artifact.payload as { external_id: string }).external_id);
});

test("a target that declares no tag budget is not subjected to one", async () => {
  const h = await harness(
    new FakePublishTarget({ requirements: { max_tags: 30, max_tag_chars: undefined } }),
  );
  const fat = Array.from({ length: 15 }, () => "y".repeat(40));
  const out = await h.publishWith({ tags: fat });
  assert.ok((out.artifact.payload as { external_id: string }).external_id);
});

// -- schema contract ----------------------------------------------------

test("the schema keeps titles inside YouTube's hard limit", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  assert.throws(
    () => registry.validate("seo_metadata", "1.0.0", { ...SEO, title: "T".repeat(101) }),
    /title/i,
  );
  assert.doesNotThrow(() =>
    registry.validate("seo_metadata", "1.0.0", { ...SEO, title: "T".repeat(100) }),
  );
});

test("the description leaves headroom under the 5000 cap for chapters later", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const reqs = new YouTubeTarget({ accessToken: "t" }).requirements();
  const schemaMax = 4800;

  assert.ok(
    schemaMax < (reqs.max_description_chars ?? 0),
    "the schema must cap below the platform, so appended chapters cannot overflow",
  );
  assert.throws(
    () => registry.validate("seo_metadata", "1.0.0", { ...SEO, description: "d".repeat(4801) }),
    /description/i,
  );
});

test("metadata without a primary keyword is not valid", async () => {
  // The keyword is what makes the listing checkable later: without a stated
  // target there is nothing to measure ranking against.
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const { primary_keyword: _omitted, ...withoutKeyword } = SEO;
  assert.throws(
    () => registry.validate("seo_metadata", "1.0.0", withoutKeyword),
    /primary_keyword/,
  );
});

test("the agent is declared to read the script, not just the story", async () => {
  // The narration is where the searchable specifics live; titling from the
  // story alone was the shortcut worth avoiding.
  const { loadAgentDefs } = await import("../src/catalog.ts");
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  const seo = agents.get("seo_optimizer")!;

  assert.deepEqual(
    seo.consumes.map((c) => c.schema_id).sort(),
    ["growth_package", "script", "story"],
  );
  assert.equal(seo.produces, "seo_metadata");
});
