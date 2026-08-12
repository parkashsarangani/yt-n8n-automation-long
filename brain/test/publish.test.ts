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
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });

const STORY = {
  topic: "Why Chile is so incredibly long",
  title: "The Country That Refused To Stop",
  hook: "Four thousand kilometres of coastline and almost no width.",
  acts: [
    { act_index: 0, act_title: "Shape", premise: "Establish the absurd geometry of it.", target_words: 300 },
    { act_index: 1, act_title: "Spine", premise: "The Andes drew the border first, before treaties.", target_words: 300 },
    { act_index: 2, act_title: "Reach", premise: "Conquest stretched it further than anyone planned.", target_words: 300 },
  ],
  payoff: "The shape is not politics. It is rock.",
  outro_line: "Send this to whoever thinks maps are boring.",
};

async function harness(target = new FakePublishTarget()) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "amos-pub-")), registry);
  const blobs = new MemoryBlobStore();
  const runLog = new MemoryRunLog();
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog,
    logger: silent(),
    blobs,
  });

  const video = await blobs.put(new TextEncoder().encode("mp4"), { role: "video" });
  const thumb = await blobs.put(new TextEncoder().encode("png"), { role: "thumbnail" });

  const seed = async (schema: string, payload: unknown, producer: string, version?: string) =>
    (
      await store.put({
        schema_id: schema,
        ...(version ? { schema_version: version } : {}),
        payload,
        produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
      })
    ).artifact;

  return { registry, store, blobs, runLog, runner, target, video, thumb, seed };
}

const rendered = (h: Awaited<ReturnType<typeof harness>>, withThumb = true) => ({
  video_uri: h.video.uri,
  media_type: "video/mp4",
  ...(withThumb ? { thumbnail_uri: h.thumb.uri } : {}),
  scene_count: 3,
  degraded_scenes: 0,
  duration_sec: 540,
});

// -- schema versioning (RFC 0007 minor bump, exercised for real) --------

test("story@1.1.0 is an additive minor bump: 1.0.0 artifacts stay valid", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));

  // The registry resolves to the newest active version...
  assert.equal(registry.resolveVersion("story"), "1.1.0");
  // ...but a consumer asking for ^1 accepts either, and the old payload — which
  // lacks the new optional fields — still validates. No migrator needed.
  assert.doesNotThrow(() => registry.validate("story", "1.0.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.1.0", STORY));
  assert.doesNotThrow(() => registry.assertCompatible("story", "1.0.0", "^1"));
  assert.doesNotThrow(() =>
    registry.validate("story", "1.1.0", {
      ...STORY,
      seo_description: "Why Chile looks like that.",
      tags: ["geography", "chile", "andes", "maps", "borders"],
    }),
  );
});

test("publish reads a story@1.0.0 artifact written before the new fields existed", async () => {
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed("story", STORY, "story_architect", "1.0.0");

  const out = await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    story.artifact_id,
  ]);

  assert.equal(story.schema_version, "1.0.0");
  assert.equal((out.artifact.payload as { external_id: string }).external_id, "fakevid_1");
  // Falls back to the payoff rather than publishing an empty description.
  assert.equal(h.target.published[0]!.metadata.description, STORY.payoff);
});

// -- publish worker -----------------------------------------------------

test("publish uploads and records where the video went", async () => {
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed(
    "story",
    { ...STORY, seo_description: "Why Chile looks like that.", tags: ["geography", "chile", "andes", "maps", "borders"] },
    "story_architect",
  );

  const out = await h.runner.run(makePublishWorker({ target: h.target, privacy: "unlisted" }), [
    video.artifact_id,
    story.artifact_id,
  ]);
  const payload = out.artifact.payload as {
    target: string;
    url: string;
    title: string;
    thumbnail_set: boolean;
    synthetic_media_disclosed: boolean;
    privacy: string;
  };

  assert.equal(payload.target, "fake-target");
  assert.equal(payload.title, STORY.title);
  assert.equal(payload.thumbnail_set, true);
  assert.equal(payload.synthetic_media_disclosed, true);
  assert.equal(payload.privacy, "unlisted");
  assert.match(payload.url, /^https:\/\/example\.test\//);

  const sent = h.target.published[0]!;
  assert.equal(sent.metadata.description, "Why Chile looks like that.");
  assert.deepEqual(sent.metadata.tags, ["geography", "chile", "andes", "maps", "borders"]);
  assert.ok(sent.thumbnail);
});

test("a refused thumbnail is recorded, not swallowed", async () => {
  // Silently falling back to an auto-selected frame changes CTR, so it has to
  // be visible in the artifact.
  const h = await harness(new FakePublishTarget({ rejectThumbnail: true }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed("story", STORY, "story_architect");

  const out = await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    story.artifact_id,
  ]);
  assert.equal((out.artifact.payload as { thumbnail_set: boolean }).thumbnail_set, false);
  // The publish itself still succeeded.
  assert.ok((out.artifact.payload as { external_id: string }).external_id);
});

test("metadata that exceeds the target's limits is rejected before upload", async () => {
  const h = await harness(new FakePublishTarget({ requirements: { max_title_chars: 10 } }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed("story", STORY, "story_architect");

  await assert.rejects(
    () => h.runner.run(makePublishWorker({ target: h.target }), [video.artifact_id, story.artifact_id]),
    /rejected before upload: title is \d+ chars/,
  );
  // Nothing was uploaded — publishing is irreversible, so validation is fatal
  // and happens first.
  assert.equal(h.target.published.length, 0);
});

test("a video longer than the target allows is rejected", async () => {
  const h = await harness(new FakePublishTarget({ requirements: { max_duration_sec: 60 } }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed("story", STORY, "story_architect");

  await assert.rejects(
    () => h.runner.run(makePublishWorker({ target: h.target }), [video.artifact_id, story.artifact_id]),
    /video is 540s, fake-target allows 60s/,
  );
});

test("a target that cannot take a custom thumbnail is never sent one", async () => {
  const h = await harness(
    new FakePublishTarget({ requirements: { supports_custom_thumbnail: false } }),
  );
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed("story", STORY, "story_architect");

  await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    story.artifact_id,
  ]);
  assert.equal(h.target.published[0]!.thumbnail, undefined);
});

test("a publish failure produces no artifact", async () => {
  const h = await harness(new FakePublishTarget({ failWith: "quota exceeded" }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const story = await h.seed("story", STORY, "story_architect");

  await assert.rejects(
    () => h.runner.run(makePublishWorker({ target: h.target }), [video.artifact_id, story.artifact_id]),
    /quota exceeded/,
  );
  assert.equal(
    (await h.store.index()).filter((r) => r.schema_id === "published_episode").length,
    0,
  );
});

// -- the YouTube adapter's call sequence --------------------------------

function youtubeStub(over: { thumbnailOk?: boolean; discloseOk?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url.replace(/\?.*$/, "")}`);
    if (url.includes("/upload/youtube/v3/videos")) {
      return new Response("{}", { status: 200, headers: { location: "https://upload.test/session" } });
    }
    if (url === "https://upload.test/session") {
      return new Response(JSON.stringify({ id: "vid_123" }), { status: 200 });
    }
    if (url.includes("/youtube/v3/videos")) {
      return new Response("{}", { status: over.discloseOk === false ? 403 : 200 });
    }
    if (url.includes("/thumbnails/set")) {
      return new Response("{}", { status: over.thumbnailOk === false ? 403 : 200 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const pubReq = {
  video: new Uint8Array([1, 2, 3]),
  media_type: "video/mp4",
  thumbnail: { bytes: new Uint8Array([9]), media_type: "image/png" },
  metadata: { title: "T", description: "D", tags: ["a"], privacy: "public" as const },
};

test("youtube uploads, then discloses synthetic media, then sets the thumbnail", async () => {
  const { fetchImpl, calls } = youtubeStub();
  const yt = new YouTubeTarget({ accessToken: "tok", fetchImpl });

  const result = await yt.publish(pubReq);

  assert.equal(result.external_id, "vid_123");
  assert.equal(result.url, "https://www.youtube.com/watch?v=vid_123");
  assert.equal(result.synthetic_media_disclosed, true);
  assert.equal(result.thumbnail_set, true);
  assert.deepEqual(calls, [
    "POST https://www.googleapis.com/upload/youtube/v3/videos",
    "PUT https://upload.test/session",
    "PUT https://www.googleapis.com/youtube/v3/videos",
    "POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set",
  ]);
});

test("youtube: a rejected thumbnail degrades, a failed disclosure does not", async () => {
  const rejected = new YouTubeTarget({
    accessToken: "tok",
    fetchImpl: youtubeStub({ thumbnailOk: false }).fetchImpl,
  });
  const out = await rejected.publish(pubReq);
  assert.equal(out.thumbnail_set, false); // published anyway
  assert.equal(out.external_id, "vid_123");

  // Disclosure is a policy obligation: failing it leaves an undisclosed video
  // live, so it throws rather than degrading.
  const undisclosed = new YouTubeTarget({
    accessToken: "tok",
    fetchImpl: youtubeStub({ discloseOk: false }).fetchImpl,
  });
  await assert.rejects(() => undisclosed.publish(pubReq), /disclosure failed/);
});

test("youtube declares its own limits; nothing upstream hardcodes them", () => {
  const reqs = new YouTubeTarget({ accessToken: "tok" }).requirements();
  assert.equal(reqs.max_title_chars, 100);
  assert.equal(reqs.requires_synthetic_media_disclosure, true);
  assert.ok(reqs.aspects.includes("16:9"));
});
