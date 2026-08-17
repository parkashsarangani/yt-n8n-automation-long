/**
 * QA checks — the code that decides whether an unattended pipeline publishes.
 *
 * Two failure directions, both expensive, and the tests exist to pin the line
 * between them:
 *
 *   too strict  an unattended pipeline stops producing anything over a script
 *               that came out slightly short, and the operator finds a week of
 *               parked runs
 *   too loose   it uploads eighty placeholder images to a real channel
 *
 * So every check is tested on both sides of its threshold, and the pass/warn/
 * fail split is asserted rather than assumed.
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
import { Runner } from "../src/runner.ts";
import { makeQaWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

interface QaPayload {
  verdict: "pass" | "fail";
  failed: number;
  warned: number;
  checks: Array<{ id: string; status: string; message: string; measured?: number | null }>;
}

/** A healthy 600s episode with 10 scenes; each test spoils one thing. */
const HEALTHY = {
  intent: { brief: "why chile is so long", target_duration_sec: 600 },
  script: {
    scenes: Array.from({ length: 10 }, (_, i) => ({
      scene_index: i,
      point: `point ${i}`,
      narration: "Narration for this scene, long enough to be real.",
    })),
    word_count: 1500, // exactly 600s at 150wpm
  },
  assets: {
    scenes: Array.from({ length: 10 }, (_, i) => ({
      scene_index: i,
      image_uri: `blob://sha256:${"a".repeat(64)}`,
      source: "primary",
      prompt: "a mountain",
    })),
    degraded_count: 0,
  },
  voice: {
    voice_id: "v1",
    clips: Array.from({ length: 10 }, (_, i) => ({
      scene_index: i,
      audio_uri: `blob://sha256:${"b".repeat(64)}`,
      duration_sec: 60,
    })),
    total_duration_sec: 600,
  },
  render: {
    video_uri: `blob://sha256:${"c".repeat(64)}`,
    media_type: "video/mp4",
    scene_count: 10,
    degraded_scenes: 0,
    duration_sec: 600,
  },
  thumbnail: {
    thumbnail_uri: `blob://sha256:${"d".repeat(64)}`,
    media_type: "image/png",
    width: 1280,
    height: 720,
    text: "It Never Existed",
    background: "supplied",
  },
  seo: {
    title: "Why Chile Is So Absurdly Long",
    description: "A description that is comfortably long enough to satisfy the schema minimum.",
    tags: ["chile", "geography", "andes", "borders", "maps"],
    primary_keyword: "why is chile so long",
    rationale: "Targets the literal question people search for.",
  },
};

type Spoil = Partial<Record<keyof typeof HEALTHY, Record<string, unknown>>>;

async function runQa(spoil: Spoil = {}, opts = {}) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-qa-")),
    registry,
  );
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
  });

  const put = async (schema: string, payload: unknown, producer: string) =>
    (
      await store.put({
        schema_id: schema,
        payload,
        produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
      })
    ).artifact.artifact_id;

  const merged = (k: keyof typeof HEALTHY) => ({ ...HEALTHY[k], ...(spoil[k] ?? {}) });

  // Order matches the worker's `consumes` — inputs bind positionally.
  const ids = [
    await put("intent", merged("intent"), "human"),
    await put("script", merged("script"), "script_writer"),
    await put("asset_manifest", merged("assets"), "asset_collector"),
    await put("voice", merged("voice"), "voice"),
    await put("rendered_video", merged("render"), "render"),
    await put("thumbnail", merged("thumbnail"), "thumbnail"),
    await put("seo_metadata", merged("seo"), "seo_optimizer"),
  ];

  const out = await runner.run(makeQaWorker(opts), ids);
  return { registry, payload: out.artifact.payload as QaPayload };
}

const check = (p: QaPayload, id: string) => p.checks.find((c) => c.id === id)!;

test("a healthy episode passes every check", async () => {
  const { registry, payload } = await runQa();

  assert.equal(payload.verdict, "pass");
  assert.equal(payload.failed, 0);
  assert.equal(payload.warned, 0, `unexpected warnings: ${JSON.stringify(payload.checks)}`);
  assert.doesNotThrow(() => registry.validate("qa_report", "1.0.0", payload));
});

// -- placeholder images -------------------------------------------------

test("one placeholder scene warns but still ships", async () => {
  // The line that matters: a single failed stock lookup is not worth throwing
  // away a finished ten-minute render over.
  const { payload } = await runQa({ assets: { degraded_count: 1 } });

  assert.equal(check(payload, "images_resolved").status, "warn");
  assert.equal(payload.verdict, "pass");
});

test("a video that is mostly placeholders fails", async () => {
  const { payload } = await runQa({ assets: { degraded_count: 8 } });

  const c = check(payload, "images_resolved");
  assert.equal(c.status, "fail");
  assert.match(c.message, /the stock lookup is failing/);
  assert.equal(payload.verdict, "fail");
});

test("the placeholder threshold is a ratio, not a count", async () => {
  // 1 of 10 is tolerable; 1 of 4 is not. A fixed count would treat them alike.
  const short = {
    script: { scenes: HEALTHY.script.scenes.slice(0, 4), word_count: 600 },
    assets: { degraded_count: 1 },
    voice: { clips: HEALTHY.voice.clips.slice(0, 4) },
    render: { scene_count: 4, duration_sec: 600 },
  };
  const { payload } = await runQa(short);
  assert.equal(check(payload, "images_resolved").status, "fail");
});

// -- narration and scenes ----------------------------------------------

test("a missing voice clip fails: the video would have silent stretches", async () => {
  const { payload } = await runQa({ voice: { clips: HEALTHY.voice.clips.slice(0, 9) } });

  assert.equal(check(payload, "narration_complete").status, "fail");
  assert.equal(payload.verdict, "fail");
});

test("a render that dropped scenes fails", async () => {
  const { payload } = await runQa({ render: { scene_count: 7 } });

  const c = check(payload, "scenes_rendered");
  assert.equal(c.status, "fail");
  assert.match(c.message, /renderer reported 7 scenes, the script has 10/);
});

// -- duration -----------------------------------------------------------

test("a video far short of its target fails", async () => {
  // The three-minutes-in-a-ten-minute-slot case, which nothing else catches.
  const { payload } = await runQa({ render: { duration_sec: 180 } });

  const c = check(payload, "duration");
  assert.equal(c.status, "fail");
  assert.match(c.message, /180s against a 600s target/);
  assert.equal(payload.verdict, "fail");
});

test("a video slightly off target passes", async () => {
  const { payload } = await runQa({ render: { duration_sec: 540 } }); // 10% under
  assert.equal(check(payload, "duration").status, "pass");
  assert.equal(payload.verdict, "pass");
});

test("a missing duration warns rather than failing", async () => {
  // Not knowing is different from being wrong, and should not block a publish.
  const { payload } = await runQa({ render: { duration_sec: undefined } });

  assert.equal(check(payload, "duration").status, "warn");
  assert.equal(payload.verdict, "pass");
});

test("a short script warns, because the render duration is the real signal", async () => {
  const { payload } = await runQa({ script: { word_count: 400 } });

  assert.equal(check(payload, "script_length").status, "warn");
  assert.equal(payload.verdict, "pass", "a word count alone must not block a publish");
});

// -- thumbnail and metadata --------------------------------------------

test("a gradient thumbnail warns but does not block", async () => {
  const { payload } = await runQa({ thumbnail: { background: "gradient" } });

  assert.equal(check(payload, "thumbnail_image").status, "warn");
  assert.equal(payload.verdict, "pass");
});

test("metadata over the platform limits fails before the upload is attempted", async () => {
  // Only the tag budget is reachable here: seo_metadata caps title at 100 and
  // description at 4800, so those can never reach QA as artifacts at all. Tags
  // can — 15 items of 40 chars is schema-legal and 600 characters, past
  // YouTube's 500 aggregate.
  const { payload } = await runQa({
    seo: { tags: Array.from({ length: 15 }, () => "x".repeat(40)) },
  });

  const c = check(payload, "metadata_limits");
  assert.equal(c.status, "fail");
  assert.match(c.message, /tags 600\/500/);
  assert.equal(payload.verdict, "fail");
});

test("the title and description limits are unreachable by construction", async () => {
  // Documents why the worker still checks them: the registry is what makes them
  // impossible, and a schema relaxed later would silently remove the guarantee.
  // Defence in depth on the one irreversible step is worth a few dead branches.
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  assert.throws(
    () => registry.validate("seo_metadata", "1.0.0", { ...HEALTHY.seo, title: "T".repeat(101) }),
    /title/,
  );
  assert.throws(
    () => registry.validate("seo_metadata", "1.0.0", { ...HEALTHY.seo, description: "d".repeat(4801) }),
    /description/,
  );
});

// -- the verdict contract ----------------------------------------------

test("warnings never produce a failing verdict", async () => {
  // Every warn-level problem at once still ships: this is the property that
  // stops an unattended pipeline from grinding to a halt on cosmetics.
  const { payload } = await runQa({
    assets: { degraded_count: 1 },
    thumbnail: { background: "gradient" },
    script: { word_count: 400 },
  });

  assert.equal(payload.warned, 3);
  assert.equal(payload.failed, 0);
  assert.equal(payload.verdict, "pass");
});

test("one failure is enough to block, even among passes", async () => {
  const { payload } = await runQa({ render: { duration_sec: 60 } });

  assert.equal(payload.failed, 1);
  assert.equal(payload.verdict, "fail");
  assert.ok(payload.checks.filter((c) => c.status === "pass").length >= 4);
});

test("thresholds are configurable, so the gate can be tuned without a code change", async () => {
  const strict = await runQa({ assets: { degraded_count: 1 } }, { maxPlaceholderRatio: 0 });
  assert.equal(strict.payload.verdict, "fail");

  const lax = await runQa({ assets: { degraded_count: 8 } }, { maxPlaceholderRatio: 0.9 });
  assert.equal(lax.payload.verdict, "pass");
});

test("every check explains itself well enough to act on at 7am", async () => {
  const { payload } = await runQa({ render: { duration_sec: 120, scene_count: 3 } });

  for (const c of payload.checks) {
    assert.ok(c.message.length >= 3, `${c.id} has no message`);
    // A failure must name the numbers, not just assert that something is wrong.
    if (c.status === "fail") assert.match(c.message, /\d/, `${c.id} failure cites no figures`);
  }
});
