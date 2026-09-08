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
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-pub-")), registry);
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


const SEO = {
  title: "Why Chile Is So Absurdly Long (It Is Not Politics)",
  description:
    "Why is Chile so long? The border was drawn by the Andes millions of years " +
    "before any treaty existed. Here is how a mountain range decided the shape " +
    "of a country, and why nobody could have drawn it differently.",
  tags: ["why is chile so long", "chile geography", "andes", "borders", "south america"],
  primary_keyword: "why is chile so long",
  rationale: "Targets the literal question people type; the video answers it directly.",
};

const seedSeo = (h: Awaited<ReturnType<typeof harness>>, over: Partial<typeof SEO> = {}) =>
  h.seed("seo_metadata", { ...SEO, ...over }, "seo_optimizer");

/** Publish also consumes the QA verdict now; a clean one unless a test says otherwise. */
const seedQa = (h: Awaited<ReturnType<typeof harness>>, verdict: "pass" | "fail" = "pass") =>
  h.seed(
    "qa_report",
    verdict === "pass"
      ? { verdict, failed: 0, warned: 0, checks: [{ id: "images_resolved", status: "pass", message: "all good" }] }
      : {
        verdict,
        failed: 1,
        warned: 0,
        checks: [
          { id: "images_resolved", status: "fail", message: "18 of 20 scenes are placeholders" },
        ],
      },
    "qa",
  );

/**
 * Publish now requires a designed thumbnail (schema `thumbnail`), so every case
 * seeds one. Inputs bind positionally, in the worker's `consumes` order:
 * rendered_video, story, thumbnail.
 */
const seedThumb = (h: Awaited<ReturnType<typeof harness>>) =>
  h.seed(
    "thumbnail",
    {
      thumbnail_uri: h.thumb.uri,
      media_type: "image/png",
      width: 1280,
      height: 720,
      text: "It Never Existed",
      background: "supplied",
    },
    "thumbnail",
  );

// -- schema versioning (RFC 0007 minor bump, exercised for real) --------

test("story@1.4.0 is an additive minor bump: 1.0.0 artifacts stay valid", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));

  // The registry resolves to the newest active version...
  assert.equal(registry.resolveVersion("story"), "1.4.0");
  // ...but a consumer asking for ^1 accepts either, and the old payload — which
  // lacks the new optional fields — still validates. No migrator needed.
  assert.doesNotThrow(() => registry.validate("story", "1.0.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.1.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.2.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.3.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.4.0", STORY));
  assert.doesNotThrow(() => registry.assertCompatible("story", "1.0.0", "^1"));
  assert.doesNotThrow(() =>
    registry.validate("story", "1.1.0", {
      ...STORY,
      seo_description: "Why Chile looks like that.",
      tags: ["geography", "chile", "andes", "maps", "borders"],
    }),
  );
  // 1.2.0 only widens who may write a story — human, for the manual-script
  // flow — it does not touch the payload shape at all. 1.3.0 (RFC 0008) adds
  // narrative_story_architect to the same allowlist. 1.4.0 adds the optional
  // genre field. None of these touch the payload's required shape.
  assert.doesNotThrow(() => registry.validate("story", "1.2.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.3.0", STORY));
  assert.doesNotThrow(() => registry.validate("story", "1.4.0", STORY));
});

test("publish uses the SEO metadata verbatim and substitutes nothing", async () => {
  // This replaced a fallback: publish used to reach into the story and swap in
  // the payoff when a description was missing. That is a decision, and it hid
  // the absence of one. The metadata now arrives reasoned-about or not at all.
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);

  await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    seo.artifact_id,
    (await seedThumb(h)).artifact_id,
    (await seedQa(h)).artifact_id,
  ]);

  const sent = h.target.published[0]!.metadata;
  assert.equal(sent.title, SEO.title);
  assert.equal(sent.description, SEO.description);
  assert.deepEqual(sent.tags, SEO.tags);
});

// -- publish worker -----------------------------------------------------

test("publish uploads even when the QA verdict is fail — approve_publish already decided this", async () => {
  // Real production request: publish() used to re-judge the QA verdict itself
  // ("belt and braces" against a graph edit routing around the gate), but that
  // makes it impossible to ever publish an episode the operator wants to review
  // and decide on manually -- the whole point of QA staying visible instead of
  // silently blocking. Whether to upload at all belongs entirely to
  // approve_publish now.
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  const qa = await seedQa(h, "fail");

  const out = await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    seo.artifact_id,
    thumb.artifact_id,
    qa.artifact_id,
  ]);

  assert.ok((out.artifact.payload as { external_id: string }).external_id);
  assert.equal(h.target.published.length, 1);
});

test("a failing QA verdict publishes private instead of the configured privacy — real production evidence", async () => {
  // Confirmed live: a scheduled/unattended run's episode had 3 of 27 scenes
  // missing their asset (qa fail), and went straight to *public* because
  // approve_publish auto-passes and nothing else was watching. Uploading
  // still isn't blocked (see the test above), but visibility downgrades to
  // private so an operator reviews it before it can go public.
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  const qa = await seedQa(h, "fail");

  const out = await h.runner.run(makePublishWorker({ target: h.target, privacy: "public" }), [
    video.artifact_id,
    seo.artifact_id,
    thumb.artifact_id,
    qa.artifact_id,
  ]);

  assert.equal((out.artifact.payload as { privacy: string }).privacy, "private");
  assert.equal(h.target.published[0]!.metadata.privacy, "private");
});

test("a passing QA verdict publishes at the configured privacy, unchanged", async () => {
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  const qa = await seedQa(h, "pass");

  const out = await h.runner.run(makePublishWorker({ target: h.target, privacy: "public" }), [
    video.artifact_id,
    seo.artifact_id,
    thumb.artifact_id,
    qa.artifact_id,
  ]);

  assert.equal((out.artifact.payload as { privacy: string }).privacy, "public");
});

test("a non-clean QA verdict (pass with warnings) publishes private, never public", async () => {
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  // verdict passes (no hard failure) but a check warned -- not clean.
  const qa = await h.seed("qa_report", {
    verdict: "pass",
    failed: 0,
    warned: 1,
    checks: [{ id: "thumbnail_image", status: "warn", message: "thumbnail background is gradient" }],
  }, "qa");

  const out = await h.runner.run(makePublishWorker({ target: h.target, privacy: "public" }), [
    video.artifact_id,
    seo.artifact_id,
    thumb.artifact_id,
    qa.artifact_id,
  ]);

  assert.equal((out.artifact.payload as { privacy: string }).privacy, "private");
  assert.equal(h.target.published[0]!.metadata.privacy, "private");
});

test("publish uploads and records where the video went", async () => {
  const h = await harness();
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);

  const out = await h.runner.run(makePublishWorker({ target: h.target, privacy: "unlisted" }), [
    video.artifact_id,
    seo.artifact_id,
    (await seedThumb(h)).artifact_id,
    (await seedQa(h)).artifact_id,
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
  assert.equal(payload.title, SEO.title);
  assert.equal(payload.thumbnail_set, true);
  assert.equal(payload.synthetic_media_disclosed, true);
  assert.equal(payload.privacy, "unlisted");
  assert.match(payload.url, /^https:\/\/example\.test\//);

  const sent = h.target.published[0]!;
  assert.equal(sent.metadata.description, SEO.description);
  assert.deepEqual(sent.metadata.tags, SEO.tags);
  assert.ok(sent.thumbnail);
});

test("a refused thumbnail is recorded, not swallowed", async () => {
  // Silently falling back to an auto-selected frame changes CTR, so it has to
  // be visible in the artifact.
  const h = await harness(new FakePublishTarget({ rejectThumbnail: true }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);

  const out = await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    seo.artifact_id,
    (await seedThumb(h)).artifact_id,
    (await seedQa(h)).artifact_id,
  ]);
  assert.equal((out.artifact.payload as { thumbnail_set: boolean }).thumbnail_set, false);
  // The publish itself still succeeded.
  assert.ok((out.artifact.payload as { external_id: string }).external_id);
});

test("metadata that exceeds the target's limits is rejected before upload", async () => {
  const h = await harness(new FakePublishTarget({ requirements: { max_title_chars: 10 } }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  const qa = await seedQa(h);

  await assert.rejects(
    () => h.runner.run(makePublishWorker({ target: h.target }), [video.artifact_id, seo.artifact_id, thumb.artifact_id, qa.artifact_id]),
    /rejected before upload: title is \d+ chars/,
  );
  // Nothing was uploaded — publishing is irreversible, so validation is fatal
  // and happens first.
  assert.equal(h.target.published.length, 0);
});

test("a video longer than the target allows is rejected", async () => {
  const h = await harness(new FakePublishTarget({ requirements: { max_duration_sec: 60 } }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  const qa = await seedQa(h);

  await assert.rejects(
    () => h.runner.run(makePublishWorker({ target: h.target }), [video.artifact_id, seo.artifact_id, thumb.artifact_id, qa.artifact_id]),
    /video is 540s, fake-target allows 60s/,
  );
});

test("a target that cannot take a custom thumbnail is never sent one", async () => {
  const h = await harness(
    new FakePublishTarget({ requirements: { supports_custom_thumbnail: false } }),
  );
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);

  await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    seo.artifact_id,
    (await seedThumb(h)).artifact_id,
    (await seedQa(h)).artifact_id,
  ]);
  assert.equal(h.target.published[0]!.thumbnail, undefined);
});

test("the designed thumbnail wins over the one the render happened to emit", async () => {
  // render() produces a thumbnail as a by-product; thumbnail_designer produces
  // one on purpose. If both exist the designed one must be uploaded, otherwise
  // the whole thumbnail branch is decorative.
  const h = await harness();
  const designedBlob = await h.blobs.put(new TextEncoder().encode("DESIGNED-PNG"), {
    role: "thumbnail",
  });

  const video = await h.seed("rendered_video", rendered(h), "render"); // carries h.thumb
  const seo = await seedSeo(h);
  const designed = await h.seed(
    "thumbnail",
    {
      thumbnail_uri: designedBlob.uri,
      media_type: "image/png",
      width: 1280,
      height: 720,
      text: "It Never Existed",
      background: "supplied",
    },
    "thumbnail",
  );

  await h.runner.run(makePublishWorker({ target: h.target }), [
    video.artifact_id,
    seo.artifact_id,
    designed.artifact_id,
    (await seedQa(h)).artifact_id,
  ]);

  const sent = h.target.published[0]!.thumbnail!;
  assert.equal(
    new TextDecoder().decode(sent.bytes),
    "DESIGNED-PNG",
    "publish uploaded the render's by-product instead of the designed thumbnail",
  );
});

test("a publish failure produces no artifact", async () => {
  const h = await harness(new FakePublishTarget({ failWith: "quota exceeded" }));
  const video = await h.seed("rendered_video", rendered(h), "render");
  const seo = await seedSeo(h);
  const thumb = await seedThumb(h);
  const qa = await seedQa(h);

  await assert.rejects(
    () => h.runner.run(makePublishWorker({ target: h.target }), [video.artifact_id, seo.artifact_id, thumb.artifact_id, qa.artifact_id]),
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

  // Disclosure failure no longer throws — it returns synthetic_media_disclosed=false
  // so the operator can fix the scope and manually disclose. The video is already
  // uploaded at this point; throwing would leave it both live AND failed.
  const undisclosed = new YouTubeTarget({
    accessToken: "tok",
    fetchImpl: youtubeStub({ discloseOk: false }).fetchImpl,
  });
  const result = await undisclosed.publish(pubReq);
  assert.equal(result.synthetic_media_disclosed, false);
  assert.equal(result.external_id, "vid_123"); // still published
});

test("youtube declares its own limits; nothing upstream hardcodes them", () => {
  const reqs = new YouTubeTarget({ accessToken: "tok" }).requirements();
  assert.equal(reqs.max_title_chars, 100);
  assert.equal(reqs.requires_synthetic_media_disclosure, true);
  assert.ok(reqs.aspects.includes("16:9"));
});
