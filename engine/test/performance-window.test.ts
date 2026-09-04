import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SchemaRegistry } from "../src/registry.ts";
import { FsArtifactStore } from "../src/store.ts";
import { buildPerformanceWindow } from "../src/performance-window.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = () => new Date("2026-08-15T12:00:00.000Z");
async function openStore() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-window-")), registry);
  return { registry, store };
}
let counter = 0;
const put = async (store: Awaited<ReturnType<typeof openStore>>["store"], schema_id: string, payload: unknown, producer: string, parents: string[] = []) =>
  (await store.put({ schema_id, payload, parents, produced_by: { transformation: producer, version: "1", run_id: `run_${counter++}`, provider: null } })).artifact;

async function episode(store: Awaited<ReturnType<typeof openStore>>["store"], o: {
  id: string; title: string; keyword: string; thumbText: string; publishedAt: string; views: number;
  retention?: number | null; ctr?: number | null; measuredAt?: string; days?: number;
  r5?: number | null; r15?: number | null; r30?: number | null;
}) {
  const seo = await put(store, "seo_metadata", { title: o.title, description: "d".repeat(60), tags: ["aa", "bb", "ccc", "dddd", "eeeee"], primary_keyword: o.keyword, rationale: "because it is the question people type" }, "seo_optimizer");
  const thumb = await put(store, "thumbnail", { thumbnail_uri: `blob://sha256:${String(counter).padStart(64, "0")}`, media_type: "image/png", width: 1280, height: 720, text: o.thumbText, background: "supplied" }, "thumbnail");
  const published = await put(store, "published_episode", { target: "youtube", external_id: o.id, url: `https://www.youtube.com/watch?v=${o.id}`, title: o.title, published_at: o.publishedAt }, "publish", [seo.artifact_id, thumb.artifact_id]);
  const r5 = o.r5 ?? null, r15 = o.r15 ?? null, r30 = o.r30 ?? null;
  return put(store, "episode_performance", {
    external_id: o.id, source: "youtube-analytics", window: { start_date: "2026-07-18", end_date: "2026-08-14", days: o.days ?? 28 }, measured_at: o.measuredAt ?? "2026-08-15T00:00:00.000Z",
    metrics: {
      views: o.views, estimated_minutes_watched: o.views * 4, average_view_duration_sec: 300,
      average_view_percentage: o.retention === undefined ? 50 : o.retention, subscribers_gained: 10, likes: 20, comments: 5, shares: 2,
      impressions: o.ctr === null ? null : 10000, click_through_rate: o.ctr === undefined ? 0.05 : o.ctr,
      retention_curve: r5 === null && r15 === null && r30 === null ? null : [{ elapsed_ratio: 0.01, audience_watch_ratio: r5 ?? 1 }],
      retention_5s: r5, retention_15s: r15, retention_30s: r30,
      unavailable: o.ctr === null ? ["videoThumbnailImpressions (not supported)"] : [],
    },
  }, "measure", [published.artifact_id]);
}

test("empty channel produces a valid v2 window with explicitly unavailable early retention", async () => {
  const { registry, store } = await openStore();
  const w = await buildPerformanceWindow(store, { now: NOW });
  assert.equal(w.episode_count, 0); assert.equal(w.ctr_available, false); assert.equal(w.retention_available, false);
  assert.equal(w.aggregates.median_views, 0); assert.equal(w.aggregates.median_view_percentage, null);
  assert.equal(w.aggregates.median_average_view_duration_sec, null);
  assert.equal(w.aggregates.median_retention_30s, null); assert.deepEqual(w.episodes, []);
  assert.doesNotThrow(() => registry.validate("performance_window", "2.1.0", w));
});

test("each measurement is joined to title, keyword, thumbnail and early retention", async () => {
  const { registry, store } = await openStore();
  await episode(store, { id: "vid1", title: "Why Chile Is So Absurdly Long", keyword: "why is chile so long", thumbText: "It Never Existed", publishedAt: "2026-07-01T10:00:00.000Z", views: 1200, r5: 0.91, r15: 0.82, r30: 0.73 });
  const w = await buildPerformanceWindow(store, { now: NOW });
  const e = w.episodes[0]!;
  assert.equal(e.title, "Why Chile Is So Absurdly Long"); assert.equal(e.primary_keyword, "why is chile so long"); assert.equal(e.thumbnail_text, "It Never Existed");
  assert.equal(e.metrics.retention_30s, 0.73); assert.equal(e.metrics.average_view_duration_sec, 300); assert.equal(w.retention_available, true);
  assert.doesNotThrow(() => registry.validate("performance_window", "2.1.0", w));
});

test("re-measuring one video counts once and newest measurement wins", async () => {
  const { store } = await openStore();
  const base = { id: "vid1", title: "Title One", keyword: "chile geography", thumbText: "x", publishedAt: "2026-07-01T10:00:00.000Z" };
  await episode(store, { ...base, views: 100, days: 7, measuredAt: "2026-07-08T00:00:00.000Z", r30: 0.5 });
  await episode(store, { ...base, views: 900, days: 28, measuredAt: "2026-08-01T00:00:00.000Z", r30: 0.7 });
  const w = await buildPerformanceWindow(store, { now: NOW });
  assert.equal(w.episode_count, 1); assert.equal(w.episodes[0]!.metrics.views, 900); assert.equal(w.episodes[0]!.metrics.retention_30s, 0.7); assert.equal(w.episodes[0]!.window_days, 28);
});

test("aggregates use medians including early-retention medians", async () => {
  const { store } = await openStore();
  const common = { keyword: "chile geography", thumbText: "x" };
  await episode(store, { ...common, id: "a", title: "Episode Alpha", publishedAt: "2026-07-01T00:00:00.000Z", views: 100, r30: 0.4 });
  await episode(store, { ...common, id: "b", title: "Episode Bravo", publishedAt: "2026-07-02T00:00:00.000Z", views: 200, r30: 0.7 });
  await episode(store, { ...common, id: "c", title: "Episode Charlie", publishedAt: "2026-07-03T00:00:00.000Z", views: 90000, r30: 0.9 });
  const w = await buildPerformanceWindow(store, { now: NOW });
  assert.equal(w.aggregates.median_views, 200); assert.equal(w.aggregates.median_average_view_duration_sec, 300); assert.equal(w.aggregates.median_retention_30s, 0.7);
  assert.notEqual(w.aggregates.median_views, (100 + 200 + 90000) / 3);
});

test("ctr availability excludes null rather than treating it as zero", async () => {
  const { store } = await openStore();
  await episode(store, { id: "a", title: "Episode Alpha", keyword: "geo", thumbText: "x", publishedAt: "2026-07-01T00:00:00.000Z", views: 100, ctr: null });
  let w = await buildPerformanceWindow(store, { now: NOW });
  assert.equal(w.ctr_available, false); assert.equal(w.aggregates.median_ctr, null);
  await episode(store, { id: "b", title: "Episode Bravo", keyword: "geo", thumbText: "y", publishedAt: "2026-07-02T00:00:00.000Z", views: 100, ctr: 0.062 });
  w = await buildPerformanceWindow(store, { now: NOW });
  assert.equal(w.ctr_available, true); assert.equal(w.aggregates.median_ctr, 0.062);
});

test("episodes are newest first", async () => {
  const { store } = await openStore();
  await episode(store, { id: "old", title: "Older Episode", keyword: "geo", thumbText: "x", publishedAt: "2026-01-01T00:00:00.000Z", views: 10 });
  await episode(store, { id: "new", title: "Newer Episode", keyword: "geo", thumbText: "x", publishedAt: "2026-08-01T00:00:00.000Z", views: 10 });
  assert.deepEqual((await buildPerformanceWindow(store, { now: NOW })).episodes.map((e) => e.external_id), ["new", "old"]);
});

test("legacy published episode without SEO/thumbnail still contributes measured evidence", async () => {
  const { registry, store } = await openStore();
  const published = await put(store, "published_episode", { target: "youtube", external_id: "legacy", url: "https://www.youtube.com/watch?v=legacy", title: "An Older Video", published_at: "2026-02-01T00:00:00.000Z" }, "publish");
  await put(store, "episode_performance", {
    external_id: "legacy", source: "youtube-analytics", window: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 }, measured_at: "2026-08-15T00:00:00.000Z",
    metrics: { views: 500, estimated_minutes_watched: 2000, average_view_duration_sec: 240, average_view_percentage: 44, subscribers_gained: 3, likes: 9, comments: 1, shares: 0, impressions: null, click_through_rate: null, retention_curve: null, retention_5s: null, retention_15s: null, retention_30s: null, unavailable: [] },
  }, "measure", [published.artifact_id]);
  const w = await buildPerformanceWindow(store, { now: NOW });
  assert.equal(w.episode_count, 1); assert.equal(w.episodes[0]!.title, "An Older Video"); assert.equal(w.episodes[0]!.thumbnail_text, undefined);
  assert.equal(w.episodes[0]!.metrics.average_view_duration_sec, 240);
  assert.doesNotThrow(() => registry.validate("performance_window", "2.1.0", w));
});
