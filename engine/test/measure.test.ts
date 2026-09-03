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
import { inferDurationSec, retentionAtSecond } from "../src/workers/measure.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });
const EPISODE = { target: "youtube", external_id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Why Chile Is So Absurdly Long", published_at: "2026-07-01T10:00:00.000Z", synthetic_media_disclosed: true, thumbnail_set: true, privacy: "private" };
interface PerfPayload { external_id: string; source: string; window: { start_date: string; end_date: string; days: number }; metrics: { views: number; average_view_percentage: number | null; impressions: number | null; click_through_rate: number | null; retention_curve: any[] | null; retention_5s: number | null; retention_15s: number | null; retention_30s: number | null; unavailable: string[] } }

async function harness(analytics: any = new FakeAnalyticsProvider(), windowDays = 28) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-measure-")), registry);
  const runner = new Runner({ store, registry, prompts: await PromptStore.load(path.join(ROOT, "prompts")), providers: new ProviderRouter({}), runLog: new MemoryRunLog(), logger: silent(), blobs: new MemoryBlobStore(), media: { analytics } });
  const episode = (await store.put({ schema_id: "published_episode", payload: EPISODE, produced_by: { transformation: "publish", version: "1", run_id: "t", provider: null } })).artifact;
  const worker = makeMeasureWorker({ windowDays, now: () => new Date("2026-08-15T12:00:00.000Z") });
  return { registry, store, runner, analytics, episode, worker };
}
const measure = async (h: Awaited<ReturnType<typeof harness>>) => (await h.runner.run(h.worker, [h.episode.artifact_id])).artifact;

test("measure emits episode_performance@2 and keeps unavailable retention distinct from zero", async () => {
  const h = await harness();
  const artifact = await measure(h);
  const out = artifact.payload as PerfPayload;
  assert.equal(artifact.schema_version, "2.0.0"); assert.equal(out.window.end_date, "2026-08-14"); assert.equal(out.window.start_date, "2026-07-18");
  assert.equal(out.metrics.retention_curve, null); assert.equal(out.metrics.retention_30s, null);
  assert.ok(out.metrics.unavailable.some((u) => /audience retention/i.test(u)));
  assert.doesNotThrow(() => h.registry.validate("episode_performance", "2.0.0", out));
});

test("official retention curve is sampled at 5/15/30 seconds using inferred video duration", async () => {
  const base = new FakeAnalyticsProvider({ overrides: { average_view_duration_sec: 60, average_view_percentage: 50 } });
  const analytics = {
    id: base.id,
    fetchVisibility: base.fetchVisibility.bind(base),
    fetchEpisodeMetrics: base.fetchEpisodeMetrics.bind(base),
    async fetchAudienceRetention() {
      return { points: [
        { elapsed_ratio: 0.04, audience_watch_ratio: 0.94 },
        { elapsed_ratio: 0.125, audience_watch_ratio: 0.84 },
        { elapsed_ratio: 0.25, audience_watch_ratio: 0.72 },
      ] };
    },
  };
  const out = (await measure(await harness(analytics))).payload as PerfPayload;
  assert.equal(out.metrics.retention_5s, 0.94); assert.equal(out.metrics.retention_15s, 0.84); assert.equal(out.metrics.retention_30s, 0.72);
  assert.equal(out.metrics.retention_curve?.length, 3);
});

test("retention sampling helpers are deterministic and return null when duration cannot be inferred", () => {
  assert.equal(inferDurationSec(60, 50), 120); assert.equal(inferDurationSec(60, null), null);
  const points = [{ elapsed_ratio: 0, audience_watch_ratio: 1 }, { elapsed_ratio: 0.25, audience_watch_ratio: 0.7 }];
  assert.equal(retentionAtSecond(points, 30, 120), 0.7); assert.equal(retentionAtSecond(points, 30, null), null);
});

test("unavailable thumbnail metrics remain null and genuine zero remains zero", async () => {
  const missing = (await measure(await harness(new FakeAnalyticsProvider({ withoutDiscoveryMetrics: true })))).payload as PerfPayload;
  assert.equal(missing.metrics.click_through_rate, null); assert.equal(missing.metrics.impressions, null);
  const zero = (await measure(await harness(new FakeAnalyticsProvider({ overrides: { views: 0, click_through_rate: 0 } })))).payload as PerfPayload;
  assert.equal(zero.metrics.views, 0); assert.equal(zero.metrics.click_through_rate, 0);
});

test("measure graph remains a separate valid flow", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const graph = await loadGraph(path.join(ROOT, "graphs", "measure.json"));
  assert.doesNotThrow(() => validateGraph(graph, { registry, transformations: new Map([["measure", makeMeasureWorker()]]) }));
});

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input); calls.push(url); const { status, body } = handler(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const ROW = (headers: string[], values: number[]) => ({ columnHeaders: headers.map((name) => ({ name })), rows: [values] });

test("YouTube aggregate provider negotiates thumbnail metrics", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: ROW(["views", "videoThumbnailImpressions", "videoThumbnailImpressionsClickRate"], [1000, 50000, 5.8]) }));
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const { metrics } = await p.fetchEpisodeMetrics("vid", { start_date: "2026-07-18", end_date: "2026-08-14" });
  assert.match(calls[0]!, /videoThumbnailImpressions/); assert.equal(metrics.impressions, 50000); assert.equal(metrics.click_through_rate, 0.058);
});

test("thumbnail metric rejection retries core metrics and latches the capability", async () => {
  let call = 0;
  const { impl, calls } = stubFetch(() => {
    call++; if (call === 1) return { status: 400, body: { error: { message: "Unknown metric videoThumbnailImpressions" } } };
    return { status: 200, body: ROW(["views", "likes"], [1000, 12]) };
  });
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const w = { start_date: "2026-07-18", end_date: "2026-08-14" };
  const first = await p.fetchEpisodeMetrics("a", w); await p.fetchEpisodeMetrics("b", w);
  assert.equal(first.metrics.click_through_rate, null); assert.equal(calls.length, 3); assert.doesNotMatch(calls[2]!, /videoThumbnailImpressions/);
});

test("YouTube audience-retention report parses elapsed ratio and watch ratio", async () => {
  const { impl, calls } = stubFetch((url) => {
    assert.match(url, /dimensions=elapsedVideoTimeRatio/); assert.match(url, /metrics=audienceWatchRatio/);
    return { status: 200, body: { columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }], rows: [[0.25, 0.72], [0, 1], [0.125, 0.84]] } };
  });
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const result = await p.fetchAudienceRetention("vid", { start_date: "2026-07-18", end_date: "2026-08-14" });
  assert.equal(calls.length, 1); assert.deepEqual(result.points?.map((x) => x.elapsed_ratio), [0, 0.125, 0.25]);
});

test("retention report rejection is recorded as unavailable, not zero", async () => {
  const { impl } = stubFetch(() => ({ status: 400, body: { error: { message: "The query is not supported", errors: [{ reason: "badRequest" }] } } }));
  const p = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: impl });
  const result = await p.fetchAudienceRetention("vid", { start_date: "2026-07-18", end_date: "2026-08-14" });
  assert.equal(result.points, null); assert.match(result.unavailable ?? "", /rejected retention report/);
});

test("analytics 403s distinguish missing API enablement from stale OAuth scope", async () => {
  const disabled = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: stubFetch(() => ({ status: 403, body: { error: { message: "YouTube Analytics API has not been used in project 324428902922 before", errors: [{ reason: "accessNotConfigured" }] } } })).impl });
  await assert.rejects(() => disabled.fetchEpisodeMetrics("vid", { start_date: "2026-07-18", end_date: "2026-08-14" }), /not enabled on this Google Cloud project/);
  const stale = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: stubFetch(() => ({ status: 403, body: { error: { message: "Forbidden" } } })).impl });
  await assert.rejects(() => stale.fetchEpisodeMetrics("vid", { start_date: "2026-07-18", end_date: "2026-08-14" }), /yt-analytics\.readonly|re-authorize/i);
});

test("visibility is read live and unknown is not guessed public", async () => {
  const fake = new FakeAnalyticsProvider({ visibility: { a: "public", b: "private" } });
  const vis = await fake.fetchVisibility(["a", "b"]); assert.equal(vis.a, "public"); assert.equal(vis.b, "private");
  const real = new YouTubeAnalyticsProvider({ accessToken: "t", fetchImpl: stubFetch(() => ({ status: 200, body: { items: [] } })).impl });
  assert.equal((await real.fetchVisibility(["gone"])).gone, "unknown");
});
