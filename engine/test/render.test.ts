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
import { ProviderRouter, ProviderError } from "../src/provider.ts";
import { FakeRenderer } from "../src/providers/fake.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";
import { Runner } from "../src/runner.ts";
import { makeRenderWorker } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

const SCRIPT = {
  scenes: [
    { scene_index: 0, point: "open", narration: "Chile is absurdly long." },
    { scene_index: 1, point: "why", narration: "The Andes drew the border." },
  ],
};

async function harness(renderer = new FakeRenderer()) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-rend-")), registry);
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
    media: { renderer },
  });

  const seed = async (schema: string, payload: unknown, producer: string) =>
    (
      await store.put({
        schema_id: schema,
        payload,
        produced_by: { transformation: producer, version: "1", run_id: "t", provider: null },
      })
    ).artifact;

  // Voice and asset artifacts, with their blobs actually present.
  const audio0 = await blobs.put(new TextEncoder().encode("a0"), { role: "audio" });
  const audio1 = await blobs.put(new TextEncoder().encode("a1"), { role: "audio" });
  const align0 = await blobs.put(new TextEncoder().encode('{"characters":["a"]}'), {
    role: "alignment",
  });
  const img0 = await blobs.put(new TextEncoder().encode("i0"), { role: "image" });
  const vid0 = await blobs.put(new TextEncoder().encode("v0"), { role: "video" });

  return { registry, store, blobs, runLog, runner, renderer, seed, audio0, audio1, align0, img0, vid0 };
}

test("render joins three artifacts by scene_index and stores the video", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const voice = await h.seed(
    "voice",
    {
      voice_id: "v1",
      clips: [
        { scene_index: 0, audio_uri: h.audio0.uri, alignment_uri: h.align0.uri, duration_sec: 4 },
        { scene_index: 1, audio_uri: h.audio1.uri, duration_sec: 5 },
      ],
    },
    "voice",
  );
  const assets = await h.seed(
    "asset_manifest",
    {
      // Deliberately out of order, and scene 1 degraded to a placeholder.
      scenes: [
        { scene_index: 1, source: "placeholder", prompt: "p1" },
        { scene_index: 0, image_uri: h.img0.uri, source: "primary", prompt: "p0" },
      ],
      degraded_count: 1,
    },
    "asset_collector",
  );

  const out = await h.runner.run(makeRenderWorker(), [
    script.artifact_id,
    voice.artifact_id,
    assets.artifact_id,
  ]);
  const payload = out.artifact.payload as {
    video_uri: string;
    scene_count: number;
    degraded_scenes: number;
    job_id?: string;
    renderer: string;
  };

  assert.equal(payload.scene_count, 2);
  assert.equal(payload.degraded_scenes, 1);
  assert.ok(await h.blobs.has(payload.video_uri));
  assert.equal(payload.renderer, "fake/renderer");

  // Joined by scene_index, not array position: scene 0 got its image even
  // though the manifest listed scene 1 first.
  const req = h.renderer.requests[0]!;
  assert.deepEqual(req.scenes.map((s) => s.scene_index), [0, 1]);
  assert.ok(req.scenes[0]!.image);
  assert.equal(req.scenes[1]!.image, undefined);
  // Alignment was fetched from its blob and decoded.
  assert.deepEqual(req.scenes[0]!.alignment, { characters: ["a"] });
});

test("plain render never sets speaker_name - the character stack was retired (RFC 0008)", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const voice = await h.seed(
    "voice",
    {
      voice_id: "v1",
      clips: [
        { scene_index: 0, audio_uri: h.audio0.uri, duration_sec: 4 },
        { scene_index: 1, audio_uri: h.audio1.uri, duration_sec: 5 },
      ],
    },
    "voice",
  );
  const assets = await h.seed(
    "asset_manifest",
    { scenes: [{ scene_index: 0, source: "placeholder", prompt: "p0" }, { scene_index: 1, source: "placeholder", prompt: "p1" }], degraded_count: 2 },
    "asset_collector",
  );

  await h.runner.run(makeRenderWorker(), [script.artifact_id, voice.artifact_id, assets.artifact_id]);

  const req = h.renderer.requests[0]!;
  assert.equal(req.scenes[0]!.speaker_name, undefined);
});

test("a scene with real stock video gets video, not image, and the two never both appear", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const voice = await h.seed(
    "voice",
    {
      voice_id: "v1",
      clips: [
        { scene_index: 0, audio_uri: h.audio0.uri, duration_sec: 4 },
        { scene_index: 1, audio_uri: h.audio1.uri, duration_sec: 5 },
      ],
    },
    "voice",
  );
  const assets = await h.seed(
    "asset_manifest",
    {
      scenes: [
        { scene_index: 0, video_uri: h.vid0.uri, source: "primary", prompt: "p0" },
        { scene_index: 1, image_uri: h.img0.uri, source: "primary", prompt: "p1" },
      ],
      degraded_count: 0,
    },
    "asset_collector",
  );

  await h.runner.run(makeRenderWorker(), [script.artifact_id, voice.artifact_id, assets.artifact_id]);

  const req = h.renderer.requests[0]!;
  assert.ok(req.scenes[0]!.video);
  assert.equal(req.scenes[0]!.image, undefined);
  assert.ok(req.scenes[1]!.image);
  assert.equal(req.scenes[1]!.video, undefined);
});

test("the external job id is written to the run log while the job is in flight", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const voice = await h.seed(
    "voice",
    {
      voice_id: "v1",
      clips: [
        { scene_index: 0, audio_uri: h.audio0.uri, duration_sec: 4 },
        { scene_index: 1, audio_uri: h.audio1.uri, duration_sec: 5 },
      ],
    },
    "voice",
  );
  const assets = await h.seed(
    "asset_manifest",
    { scenes: [{ scene_index: 0, source: "placeholder", prompt: "p" }], degraded_count: 1 },
    "asset_collector",
  );

  const out = await h.runner.run(makeRenderWorker(), [
    script.artifact_id,
    voice.artifact_id,
    assets.artifact_id,
  ]);

  const records = await h.runLog.all();
  const running = records.find((r) => r.status === "running");
  assert.ok(running, "expected an interim running record");
  assert.equal(running!.external_job_id, "fakejob_1");
  assert.match(running!.detail ?? "", /render job started/);
  // And the job id survives onto the artifact, for cross-referencing later.
  assert.equal((out.artifact.payload as { job_id?: string }).job_id, "fakejob_1");
});

test("a scene with narration but no audio fails loudly", async () => {
  const h = await harness();
  const script = await h.seed("script", SCRIPT, "script_writer");
  const voice = await h.seed(
    "voice",
    { voice_id: "v1", clips: [{ scene_index: 0, audio_uri: h.audio0.uri, duration_sec: 4 }] },
    "voice",
  );
  const assets = await h.seed(
    "asset_manifest",
    { scenes: [{ scene_index: 0, source: "placeholder", prompt: "p" }], degraded_count: 1 },
    "asset_collector",
  );

  await assert.rejects(
    () =>
      h.runner.run(makeRenderWorker(), [script.artifact_id, voice.artifact_id, assets.artifact_id]),
    /no voice clip for scene 1/,
  );
});

test("a render failure is recorded and produces no artifact", async () => {
  const h = await harness(new FakeRenderer("encoder died"));
  const script = await h.seed("script", SCRIPT, "script_writer");
  const voice = await h.seed(
    "voice",
    {
      voice_id: "v1",
      clips: [
        { scene_index: 0, audio_uri: h.audio0.uri, duration_sec: 4 },
        { scene_index: 1, audio_uri: h.audio1.uri, duration_sec: 5 },
      ],
    },
    "voice",
  );
  const assets = await h.seed(
    "asset_manifest",
    { scenes: [{ scene_index: 0, source: "placeholder", prompt: "p" }], degraded_count: 1 },
    "asset_collector",
  );

  await assert.rejects(
    () =>
      h.runner.run(makeRenderWorker(), [script.artifact_id, voice.artifact_id, assets.artifact_id]),
    /encoder died/,
  );
  const records = await h.runLog.all();
  // The job id was still captured before the failure — that is the point of
  // reporting it early.
  assert.equal(records.find((r) => r.status === "running")?.external_job_id, "fakejob_1");
  assert.ok(records.some((r) => r.status === "failed"));
  assert.equal((await h.store.index()).filter((r) => r.schema_id === "rendered_video").length, 0);
});

// -- the long-compose adapter's job protocol ---------------------------

function composeStub(script: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  let poll = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/compose")) {
      return new Response(JSON.stringify({ job_id: "job_7", status: "processing" }), {
        status: 202,
      });
    }
    if (url.includes("/compose-status/")) {
      const body = script[Math.min(poll++, script.length - 1)]!;
      return new Response(JSON.stringify(body), { status: body["status"] === "failed" ? 500 : 200 });
    }
    if (url.includes("/outputs/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => { };

test("compose renderer polls until done and surfaces the job id immediately", async () => {
  const { fetchImpl, calls } = composeStub([
    { status: "processing" },
    { status: "processing" },
    { status: "done", success: true, output_path: "/app/outputs/long_x.mp4", render_time_sec: 91 },
  ]);
  const renderer = new ComposeRenderer({
    baseUrl: "https://compose.example",
    fetchImpl,
    sleepImpl: noSleep,
  });

  const seen: string[] = [];
  const result = await renderer.render(
    {
      scenes: [
        { scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" },
      ],
    },
    { onJob: (id) => void seen.push(id) },
  );

  assert.deepEqual(seen, ["job_7"]); // surfaced before the polling begins
  assert.equal(result.render_time_sec, 91);
  assert.deepEqual([...result.video], [1, 2, 3]);
  assert.equal(calls.filter((c) => c.includes("/compose-status/")).length, 3);
  assert.ok(calls.some((c) => c.includes("/outputs/long_x.mp4")));
});

test("compose renderer sends a scene's video as video_base64, never alongside images_base64", async () => {
  const { fetchImpl } = composeStub([
    { status: "done", success: true, output_path: "/app/outputs/x.mp4" },
  ]);
  let sentBody: Record<string, unknown> | undefined;
  const capturingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/compose")) sentBody = JSON.parse(String(init?.body));
    return fetchImpl(input, init);
  }) as unknown as typeof fetch;

  const renderer = new ComposeRenderer({
    baseUrl: "https://compose.example",
    fetchImpl: capturingFetch,
    sleepImpl: noSleep,
  });

  await renderer.render({
    scenes: [
      {
        scene_index: 0,
        audio: new Uint8Array([1]),
        audio_media_type: "audio/mpeg",
        video: new Uint8Array([9, 9]),
        video_media_type: "video/mp4",
      },
    ],
  });

  const scene = (sentBody!["data"] as Array<Record<string, unknown>>)[0]!;
  assert.ok(scene["video_base64"]);
  assert.equal(scene["images_base64"], undefined);
});

test("compose renderer reports the service's own error on a failed job", async () => {
  const { fetchImpl } = composeStub([{ status: "failed", success: false, error: "OOM in ffmpeg" }]);
  const renderer = new ComposeRenderer({
    baseUrl: "https://compose.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  await assert.rejects(
    () =>
      renderer.render({
        scenes: [{ scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" }],
      }),
    /OOM in ffmpeg/,
  );
});

test("compose renderer gives up rather than polling forever", async () => {
  const { fetchImpl } = composeStub([{ status: "processing" }]);
  const renderer = new ComposeRenderer({
    baseUrl: "https://compose.example",
    fetchImpl,
    sleepImpl: noSleep,
    timeoutSec: 0,
  });
  await assert.rejects(
    () =>
      renderer.render({
        scenes: [{ scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" }],
      }),
    ProviderError,
  );
});

test("compose renderer logs why supplied thumbnail artwork degraded to a gradient", async () => {
  // The first /thumbnail call (with real artwork) fails; the retry without
  // artwork succeeds. Nothing about that first failure is otherwise visible
  // to a caller — the returned result just says background: "gradient" —
  // so this only reaches the operator through the console.warn.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { image_base64: string | null };
    if (body.image_base64) {
      return new Response(JSON.stringify({ success: false, error: "ffmpeg: unsupported pixel format" }), {
        status: 500,
      });
    }
    return new Response(
      JSON.stringify({ success: true, image_base64: "AAAA", media_type: "image/png", background: "gradient" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const renderer = new ComposeRenderer({ baseUrl: "https://compose.example", fetchImpl });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => void warnings.push(msg);
  try {
    const result = await renderer.renderThumbnail({ image: new Uint8Array([1, 2, 3]), text: "IT HUMS" });
    assert.equal(result.background, "gradient");
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    warnings.some((w) => w.includes("degraded to gradient") && w.includes("ffmpeg: unsupported pixel format")),
    `expected a warning naming the swallowed failure, got: ${JSON.stringify(warnings)}`,
  );
});
