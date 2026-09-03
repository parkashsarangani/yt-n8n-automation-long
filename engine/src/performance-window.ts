/**
 * Builds the performance_window input artifact by joining measured outcomes to
 * the creative decisions that produced them. RFC 0009 carries negotiated
 * early-retention samples into this window so future packages/hooks can learn
 * from actual 5/15/30-second audience behavior.
 */

import type { Artifact } from "./artifact.ts";
import type { ArtifactStore } from "./store.ts";

export interface WindowEpisode {
  external_id: string;
  title?: string;
  primary_keyword?: string;
  thumbnail_text?: string;
  published_at?: string;
  window_days?: number;
  metrics: {
    views: number;
    average_view_percentage: number | null;
    click_through_rate: number | null;
    retention_5s: number | null;
    retention_15s: number | null;
    retention_30s: number | null;
    subscribers_gained: number;
    likes: number;
    comments: number;
  };
}

export interface PerformanceWindow {
  generated_at: string;
  episode_count: number;
  ctr_available: boolean;
  retention_available: boolean;
  aggregates: {
    median_views: number;
    median_view_percentage: number | null;
    median_ctr: number | null;
    median_retention_5s: number | null;
    median_retention_15s: number | null;
    median_retention_30s: number | null;
    total_subscribers_gained: number;
  };
  episodes: WindowEpisode[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function round6(n: number | null): number | null {
  return n === null ? null : Math.round(n * 1e6) / 1e6;
}

export function excludedIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env["MEASURE_EXCLUDE_IDS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export async function buildPerformanceWindow(
  store: ArtifactStore,
  opts: { now?: () => Date; maxEpisodes?: number; exclude?: Set<string> } = {},
): Promise<PerformanceWindow> {
  const now = opts.now ?? (() => new Date());
  const maxEpisodes = opts.maxEpisodes ?? 200;
  const exclude = opts.exclude ?? excludedIds();
  const rows = (await store.index()).filter((r) => r.schema_id === "episode_performance");

  const latest = new Map<string, { artifact: Artifact; createdAt: string }>();
  for (const row of rows) {
    const artifact = await store.get(row.artifact_id);
    if (!artifact) continue;
    const payload = artifact.payload as { external_id?: string; measured_at?: string };
    const id = payload.external_id;
    if (!id || exclude.has(id)) continue;
    const createdAt = payload.measured_at ?? row.created_at;
    const seen = latest.get(id);
    if (!seen || createdAt > seen.createdAt) latest.set(id, { artifact, createdAt });
  }

  const episodes: WindowEpisode[] = [];
  for (const { artifact } of latest.values()) {
    const p = artifact.payload as {
      external_id: string;
      window?: { days?: number };
      metrics: {
        views: number;
        average_view_percentage?: number | null;
        click_through_rate?: number | null;
        retention_5s?: number | null;
        retention_15s?: number | null;
        retention_30s?: number | null;
        subscribers_gained: number;
        likes: number;
        comments: number;
      };
    };
    const context = await describeAncestors(store, artifact.artifact_id);
    episodes.push({
      external_id: p.external_id,
      ...context,
      ...(p.window?.days !== undefined ? { window_days: p.window.days } : {}),
      metrics: {
        views: p.metrics.views,
        average_view_percentage: p.metrics.average_view_percentage ?? null,
        click_through_rate: p.metrics.click_through_rate ?? null,
        retention_5s: p.metrics.retention_5s ?? null,
        retention_15s: p.metrics.retention_15s ?? null,
        retention_30s: p.metrics.retention_30s ?? null,
        subscribers_gained: p.metrics.subscribers_gained,
        likes: p.metrics.likes,
        comments: p.metrics.comments,
      },
    });
  }

  episodes.sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const kept = episodes.slice(0, maxEpisodes);
  const nonNull = (key: "click_through_rate" | "average_view_percentage" | "retention_5s" | "retention_15s" | "retention_30s"): number[] =>
    kept.map((e) => e.metrics[key]).filter((v): v is number => v !== null);
  const ctrs = nonNull("click_through_rate");
  const r5 = nonNull("retention_5s");
  const r15 = nonNull("retention_15s");
  const r30 = nonNull("retention_30s");

  return {
    generated_at: now().toISOString(),
    episode_count: kept.length,
    ctr_available: ctrs.length > 0,
    retention_available: r5.length > 0 || r15.length > 0 || r30.length > 0,
    aggregates: {
      median_views: median(kept.map((e) => e.metrics.views)) ?? 0,
      median_view_percentage: round6(median(nonNull("average_view_percentage"))),
      median_ctr: round6(median(ctrs)),
      median_retention_5s: round6(median(r5)),
      median_retention_15s: round6(median(r15)),
      median_retention_30s: round6(median(r30)),
      total_subscribers_gained: kept.reduce((n, e) => n + e.metrics.subscribers_gained, 0),
    },
    episodes: kept,
  };
}

async function describeAncestors(
  store: ArtifactStore,
  artifactId: string,
): Promise<Partial<WindowEpisode>> {
  const out: Partial<WindowEpisode> = {};
  let ancestors: Artifact[];
  try {
    ancestors = await store.lineage(artifactId);
  } catch {
    return out;
  }

  for (const a of ancestors) {
    const payload = a.payload as Record<string, unknown>;
    if (a.schema_id === "published_episode") {
      if (typeof payload["title"] === "string") out.title = payload["title"];
      if (typeof payload["published_at"] === "string") out.published_at = payload["published_at"];
    } else if (a.schema_id === "seo_metadata") {
      if (typeof payload["primary_keyword"] === "string") out.primary_keyword = payload["primary_keyword"];
      if (typeof payload["title"] === "string") out.title = payload["title"];
    } else if (a.schema_id === "thumbnail") {
      if (typeof payload["text"] === "string") out.thumbnail_text = payload["text"];
    }
  }
  return out;
}
