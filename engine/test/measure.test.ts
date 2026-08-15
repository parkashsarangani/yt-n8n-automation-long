/**
 * Measurement: the worker, and the provider's negotiation with an API whose
 * capabilities we cannot assume.
 *
 * The recurring theme is the difference between zero and unknown. A view count
 * of 0 is a measurement. A click-through rate of null is the platform declining
 * to answer. Collapsing the second into the first would let the insights agent
 * conclude "this thumbnail got no clicks" from "nobody told us", which is the
 * worst possible failure for a feedback loop.
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
import { FakeAnalyticsProvider } from "../src/providers/fake.ts";
import { YouTubeAnalyticsProvider } from "../src/providers/youtube-analytics.ts";
import { Runner } from "../src/runner.ts";
import { makeMeasureWorker } from "../src/workers/index.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

const EPISODE = {
  target: "youtube",
  external_id: "dQw4w9WgXcQ",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Why Chile Is So Absurdly Long",
  published_at: "2026-07-01T10:00:00.000Z",
  synthetic_media_disclosed: true,
  thumbnail_set: true,
  privacy: "private",
};

interface PerfPayload {
  external_id: string;
  source: string;
  window: { start_date: string; end_date: string; days: number };
  measured_at: string;
  metrics: {
    views: number;
    average_view_percentage: number | null;
    impressions: number | null;
    click_through_rate: number | null;
    unavailable: string[];
  };
}

async function harness(analytics = new FakeAnalyticsProvider(), windowDays = 28) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-measure-")),
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
    media: { analytics },
  });

  const episode = (
    await store.put({
      schema_id: "published_episode",
      payload: EPISODE,
      produced_by: { transformation: "publish", version: "1", run_id: "t", provider: null },
    })
  ).artifact;

  // Fixed clock so window arithmetic is assertable.
  const worker = makeMeasureWorker({
    windowDays,
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });

  return { registry, store, runner, analytics, episode, worker };
}

const measure = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.runner.run(h.worker, [h.episode.artifact_id])).artifact.payload as PerfPayload;

test("measures the published video over the requested window", async () => {
  const h = await harness();
  const out = await measure(h);

  assert.equal(out.external_id, EPISODE.external_id);
  assert.equal(out.source, "fake/analytics");
  assert.equal(out.window.days, 28);
  assert.ok(out.metrics.views > 0);
  assert.equal(h.analytics.calls[0]!.externalId, EPISODE.external_id);
});

test("the window ends yesterday, because today is always partial", async () => {
  // A half-day of data drags every average down and makes runs incomparable.
  const h = await harness(new FakeAnalyticsProvider(), 28);
  const out = await measure(h);

  assert.equal(out.window.end_date, "2026-08-14", "must not include the current day");
  // 28 days inclusive, ending 2026-08-14 -> starts 2026-07-18.
  assert.equal(out.window.start_date, "2026-07-18");
});

test("a shorter window is honoured exactly", async () => {
  const h = await harness(new FakeAnalyticsProvider(), 7);
  const out = await measure(h);
  assert.equal(out.window.start_date, "2026-08-08");
  assert.equal(out.window.end_date, "2026-08-14");
  assert.equal(out.window.days, 7);
});

test("an unavailable metric is null and named, never silently zero", async () => {
  const h = await harness(new FakeAnalyticsProvider({ withoutDiscoveryMetrics: true }));
  const out = await measure(h);

  assert.equal(out.metrics.click_through_rate, null);
  assert.equal(out.metrics.impressions, null);
  assert.ok(
    out.metrics.unavailable.some((u) => /videoThumbnailImpressions/.test(u)),
    "the artifact must say which metrics the platform withheld",
  );
});

test("a genuine zero is recorded as zero, not as unavailable", async () => {
  const h = await harness(
    new FakeAnalyticsProvider({ overrides: { views: 0, click_through_rate: 0 } }),
  );
  const out = await measure(h);

  assert.equal(out.metrics.views, 0);
  assert.equal(out.metrics.click_through_rate, 0);
  assert.deepEqual(out.metrics.unavailable, [], "zero is an answer, not a gap");
});

test("measuring without an analytics provider fails loudly", async () => {
  const h = await harness();
  const runner = new Runner({
    store: h.store,
    registry: h.registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
    media: {},
  });

  await assert.rejects(
    () => runner.run(h.worker, [h.episode.artifact_id]),
    /needs an analytics provider/,
  );
});

test("re-measuring over a longer window adds an artifact instead of replacing one", async () => {
  // Artifacts are immutable: how a video aged must stay inspectable.
  const h7 = await harness(new FakeAnalyticsProvider(), 7);
  const short = await h7.runner.run(h7.worker, [h7.episode.artifact_id]);

  const longWorker = makeMeasureWorker({
    windowDays: 28,
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });
  const long = await h7.runner.run(longWorker, [h7.episode.artifact_id]);

  assert.notEqual(short.artifact.artifact_id, long.artifact.artifact_id);
  const rows = (await h7.store.index()).filter((r) => r.schema_id === "episode_performance");
  assert.equal(rows.length, 2);
});

test("the artifact validates against the registry schema", async () => {
  const h = await harness();
  const out = await measure(h);
  assert.doesNotThrow(() => h.registry.validate("episode_performance", "1.0.0", out));
});

test("the measure graph is a valid, separate flow", async () => {
  // Measurement is not part of production: it runs days later, on its own.
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const graph = await loadGraph(path.join(ROOT, "graphs", "measure.json"));
  const transformations = new Map([["measure", makeMeasureWorker()]]);

  assert.doesNotThrow(() => validateGraph(graph, { registry, transformations }));
  assert.equal(graph.graph_id, "measure");
});

// -- provider negotiation ----------------------------------------------

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ROW = (headers: string[], values: number[]) => ({
  columnHeaders: headers.map((name) => ({ name })),
  rows: [values],
});

test("provider asks for thumbnail metrics and uses them when offered", async () => {
  const { impl, calls } = stubFetch(() => ({
    status: 200,
    body: ROW(
      ["views", "videoThumbnailImpressions", "videoThumbnailImpressionsClickRate"],
      [1000, 50000, 5.8],
    ),
  }));
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const { metrics } = await p.fetchEpisodeMetrics("vid", {
    start_date: "2026-07-18",
    end_date: "2026-08-14",
  });

  assert.match(calls[0]!, /videoThumbnailImpressions/);
  assert.equal(metrics.impressions, 50000);
  // Reported as a percentage by the API, normalised to a fraction here so the
  // unit is unambiguous everywhere downstream.
  assert.equal(metrics.click_through_rate, 0.058);
  assert.deepEqual(metrics.unavailable, []);
});

test("provider retries without the thumbnail metrics if the API rejects them", async () => {
  // The whole point of negotiating: we do not know whether this API exposes
  // click-through, and guessing wrong either loses the metric or breaks measurement.
  let call = 0;
  const { impl, calls } = stubFetch(() => {
    call += 1;
    if (call === 1) {
      return { status: 400, body: { error: { message: "Unknown metric videoThumbnailImpressions" } } };
    }
    return { status: 200, body: ROW(["views", "likes"], [1000, 12]) };
  });

  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const { metrics } = await p.fetchEpisodeMetrics("vid", {
    start_date: "2026-07-18",
    end_date: "2026-08-14",
  });

  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1]!, /videoThumbnailImpressions/, "retry must drop them");
  assert.equal(metrics.views, 1000);
  assert.equal(metrics.click_through_rate, null);
  assert.ok(metrics.unavailable.length > 0);
});

test("the rejection is remembered, so later episodes cost one request not two", async () => {
  let call = 0;
  const { impl, calls } = stubFetch(() => {
    call += 1;
    if (call === 1) return { status: 400, body: { error: { message: "Unknown metric" } } };
    return { status: 200, body: ROW(["views"], [10]) };
  });

  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const w = { start_date: "2026-07-18", end_date: "2026-08-14" };
  await p.fetchEpisodeMetrics("a", w);
  await p.fetchEpisodeMetrics("b", w);

  assert.equal(calls.length, 3, "2 for the first episode (probe + retry), 1 for the second");
  assert.doesNotMatch(calls[2]!, /videoThumbnailImpressions/);
});

test("a 403 explains that the token predates the analytics scope", async () => {
  // The failure a real operator will actually hit, since the upload scopes do
  // not imply yt-analytics.readonly and Google will not widen an old grant.
  const { impl } = stubFetch(() => ({ status: 403, body: { error: { message: "Forbidden" } } }));
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });

  await assert.rejects(
    () => p.fetchEpisodeMetrics("vid", { start_date: "2026-07-18", end_date: "2026-08-14" }),
    /yt-analytics\.readonly|re-authorize/i,
  );
});

test("a video with no data in the window reports zeros, not an error", async () => {
  // A freshly published video legitimately has no rows yet.
  const { impl } = stubFetch(() => ({
    status: 200,
    body: { columnHeaders: [{ name: "views" }, { name: "likes" }] }, // no rows
  }));
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const { metrics } = await p.fetchEpisodeMetrics("vid", {
    start_date: "2026-08-14",
    end_date: "2026-08-14",
  });

  assert.equal(metrics.views, 0);
  assert.equal(metrics.likes, 0);
});
