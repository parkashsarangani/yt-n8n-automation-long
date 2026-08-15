/**
 * The join that turns measurements into evidence.
 *
 * A view count on its own says nothing actionable. A view count sitting next to
 * the title, keyword and thumbnail text that produced it is something the
 * strategist can reason about — and getting that attribution wrong is worse
 * than having none, because the guidance it produces will look just as
 * confident either way.
 */

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

async function store() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const s = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-window-")),
    registry,
  );
  return { registry, store: s };
}

let counter = 0;
const put = async (
  s: Awaited<ReturnType<typeof store>>["store"],
  schema_id: string,
  payload: unknown,
  producer: string,
  parents: string[] = [],
) =>
  (
    await s.put({
      schema_id,
      payload,
      parents,
      produced_by: {
        transformation: producer,
        version: "1",
        run_id: `run_${counter++}`,
        provider: null,
      },
    })
  ).artifact;

/** A full episode chain: seo + thumbnail -> published -> measured. */
async function episode(
  s: Awaited<ReturnType<typeof store>>["store"],
  o: {
    id: string;
    title: string;
    keyword: string;
    thumbText: string;
    publishedAt: string;
    views: number;
    retention?: number | null;
    ctr?: number | null;
    measuredAt?: string;
    days?: number;
  },
) {
  const seo = await put(
    s,
    "seo_metadata",
    {
      title: o.title,
      description: "d".repeat(60),
      tags: ["aa", "bb", "ccc", "dddd", "eeeee"],
      primary_keyword: o.keyword,
      rationale: "because it is the question people type",
    },
    "seo_optimizer",
  );
  const thumb = await put(
    s,
    "thumbnail",
    {
      thumbnail_uri: `blob://sha256:${String(counter).padStart(64, "0")}`,
      media_type: "image/png",
      width: 1280,
      height: 720,
      text: o.thumbText,
      background: "supplied",
    },
    "thumbnail",
  );
  const published = await put(
    s,
    "published_episode",
    {
      target: "youtube",
      external_id: o.id,
      url: `https://www.youtube.com/watch?v=${o.id}`,
      title: o.title,
      published_at: o.publishedAt,
    },
    "publish",
    [seo.artifact_id, thumb.artifact_id],
  );
  return put(
    s,
    "episode_performance",
    {
      external_id: o.id,
      source: "youtube-analytics",
      window: { start_date: "2026-07-18", end_date: "2026-08-14", days: o.days ?? 28 },
      measured_at: o.measuredAt ?? "2026-08-15T00:00:00.000Z",
      metrics: {
        views: o.views,
        estimated_minutes_watched: o.views * 4,
        average_view_duration_sec: 300,
        average_view_percentage: o.retention === undefined ? 50 : o.retention,
        subscribers_gained: 10,
        likes: 20,
        comments: 5,
        shares: 2,
        impressions: o.ctr === null ? null : 10000,
        click_through_rate: o.ctr === undefined ? 0.05 : o.ctr,
        unavailable: o.ctr === null ? ["videoThumbnailImpressions (not supported)"] : [],
      },
    },
    "measure",
    [published.artifact_id],
  );
}

test("an empty channel produces a valid, explicitly empty window", async () => {
  // The state every first run starts in. It must be a first-class case, not a
  // gap — the strategist is told to return no guidance when it sees this.
  const { registry, store: s } = await store();
  const w = await buildPerformanceWindow(s, { now: NOW });

  assert.equal(w.episode_count, 0);
  assert.equal(w.ctr_available, false);
  assert.deepEqual(w.episodes, []);
  assert.equal(w.aggregates.median_views, 0);
  assert.equal(w.aggregates.median_view_percentage, null);
  assert.doesNotThrow(() => registry.validate("performance_window", "1.0.0", w));
});

test("each measurement is joined to the decisions that produced it", async () => {
  const { registry, store: s } = await store();
  await episode(s, {
    id: "vid1",
    title: "Why Chile Is So Absurdly Long",
    keyword: "why is chile so long",
    thumbText: "It Never Existed",
    publishedAt: "2026-07-01T10:00:00.000Z",
    views: 1200,
  });

  const w = await buildPerformanceWindow(s, { now: NOW });
  const [e] = w.episodes;

  assert.equal(w.episode_count, 1);
  assert.equal(e!.external_id, "vid1");
  assert.equal(e!.title, "Why Chile Is So Absurdly Long");
  assert.equal(e!.primary_keyword, "why is chile so long");
  assert.equal(e!.thumbnail_text, "It Never Existed", "thumbnail text must survive the join");
  assert.equal(e!.published_at, "2026-07-01T10:00:00.000Z");
  assert.doesNotThrow(() => registry.validate("performance_window", "1.0.0", w));
});

test("re-measuring the same video counts once, using the newest measurement", async () => {
  // Measurements accumulate rather than overwrite, so without de-duplication a
  // video measured three times would triple its weight in every median.
  const { store: s } = await store();
  const base = {
    id: "vid1",
    title: "Title One",
    keyword: "chile geography",
    thumbText: "x",
    publishedAt: "2026-07-01T10:00:00.000Z",
  };
  await episode(s, { ...base, views: 100, days: 7, measuredAt: "2026-07-08T00:00:00.000Z" });
  await episode(s, { ...base, views: 900, days: 28, measuredAt: "2026-08-01T00:00:00.000Z" });

  const w = await buildPerformanceWindow(s, { now: NOW });

  assert.equal(w.episode_count, 1, "one video, one row");
  assert.equal(w.episodes[0]!.metrics.views, 900, "the newest measurement wins");
  assert.equal(w.episodes[0]!.window_days, 28);
});

test("aggregates use the median, so one viral episode is not treated as normal", async () => {
  const { store: s } = await store();
  const common = { keyword: "chile geography", thumbText: "x" };
  await episode(s, { ...common, id: "a", title: "Episode Alpha", publishedAt: "2026-07-01T00:00:00.000Z", views: 100 });
  await episode(s, { ...common, id: "b", title: "Episode Bravo", publishedAt: "2026-07-02T00:00:00.000Z", views: 200 });
  await episode(s, { ...common, id: "c", title: "Episode Charlie", publishedAt: "2026-07-03T00:00:00.000Z", views: 90000 });

  const w = await buildPerformanceWindow(s, { now: NOW });

  assert.equal(w.aggregates.median_views, 200);
  // The mean would be 30100 — a number no episode is remotely near, and one
  // that would make every future video look like a failure.
  assert.notEqual(w.aggregates.median_views, (100 + 200 + 90000) / 3);
});

test("ctr_available is false when the platform withheld click-through everywhere", async () => {
  // Bounds what the strategist may claim about thumbnails at all.
  const { store: s } = await store();
  await episode(s, {
    id: "a", title: "Episode Alpha", keyword: "chile geography", thumbText: "x",
    publishedAt: "2026-07-01T00:00:00.000Z", views: 100, ctr: null,
  });

  const w = await buildPerformanceWindow(s, { now: NOW });
  assert.equal(w.ctr_available, false);
  assert.equal(w.aggregates.median_ctr, null);
  assert.equal(w.episodes[0]!.metrics.click_through_rate, null);
});

test("one episode with click-through is enough to make it available", async () => {
  const { store: s } = await store();
  await episode(s, { id: "a", title: "Episode Alpha", keyword: "chile geography", thumbText: "x", publishedAt: "2026-07-01T00:00:00.000Z", views: 100, ctr: null });
  await episode(s, { id: "b", title: "Episode Bravo", keyword: "chile geography", thumbText: "y", publishedAt: "2026-07-02T00:00:00.000Z", views: 100, ctr: 0.062 });

  const w = await buildPerformanceWindow(s, { now: NOW });
  assert.equal(w.ctr_available, true);
  assert.equal(w.aggregates.median_ctr, 0.062, "the null must be excluded, not counted as zero");
});

test("episodes come back newest first", async () => {
  const { store: s } = await store();
  await episode(s, { id: "old", title: "Older Episode", keyword: "chile geography", thumbText: "x", publishedAt: "2026-01-01T00:00:00.000Z", views: 10 });
  await episode(s, { id: "new", title: "Newer Episode", keyword: "chile geography", thumbText: "x", publishedAt: "2026-08-01T00:00:00.000Z", views: 10 });

  const w = await buildPerformanceWindow(s, { now: NOW });
  assert.deepEqual(w.episodes.map((e) => e.external_id), ["new", "old"]);
});

test("an episode published before the SEO and thumbnail agents existed still counts", async () => {
  // Its numbers are real even though the attribution is missing; dropping it
  // would silently shrink the evidence base.
  const { registry, store: s } = await store();
  const published = await put(
    s,
    "published_episode",
    {
      target: "youtube",
      external_id: "legacy",
      url: "https://www.youtube.com/watch?v=legacy",
      title: "An Older Video",
      published_at: "2026-02-01T00:00:00.000Z",
    },
    "publish",
  );
  await put(
    s,
    "episode_performance",
    {
      external_id: "legacy",
      source: "youtube-analytics",
      window: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 },
      measured_at: "2026-08-15T00:00:00.000Z",
      metrics: {
        views: 500, estimated_minutes_watched: 2000, average_view_duration_sec: 240,
        average_view_percentage: 44, subscribers_gained: 3, likes: 9, comments: 1,
        shares: 0, impressions: null, click_through_rate: null, unavailable: [],
      },
    },
    "measure",
    [published.artifact_id],
  );

  const w = await buildPerformanceWindow(s, { now: NOW });
  assert.equal(w.episode_count, 1);
  assert.equal(w.episodes[0]!.title, "An Older Video");
  assert.equal(w.episodes[0]!.thumbnail_text, undefined);
  assert.doesNotThrow(() => registry.validate("performance_window", "1.0.0", w));
});
