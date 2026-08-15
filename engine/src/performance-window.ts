/**
 * Builds the performance_window input artifact.
 *
 * This lives in the service layer rather than in a worker on purpose. Workers
 * see only their declared inputs (RFC 0003), which is what makes them
 * reproducible — and assembling this needs a query across the entire store plus
 * a lineage walk per episode. That is not a transformation of declared parents,
 * so it is seeded as a graph input, exactly like `intent`.
 *
 * The join is the point. A view count on its own is trivia; a view count next
 * to the title, keyword and thumbnail text that produced it is something the
 * strategist can reason about.
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
    subscribers_gained: number;
    likes: number;
    comments: number;
  };
}

export interface PerformanceWindow {
  generated_at: string;
  episode_count: number;
  ctr_available: boolean;
  aggregates: {
    median_views: number;
    median_view_percentage: number | null;
    median_ctr: number | null;
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

/** Median, not mean: one viral episode should not redefine "normal". */
function round6(n: number | null): number | null {
  return n === null ? null : Math.round(n * 1e6) / 1e6;
}

/** Video ids the operator has excluded from the feedback loop. */
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
  // Enforced here as well as at collection time: an episode measured before it
  // was excluded still has an artifact on disk, and the exclusion has to hold
  // wherever the data is read, not only where it is gathered.
  const exclude = opts.exclude ?? excludedIds();

  const rows = (await store.index()).filter((r) => r.schema_id === "episode_performance");

  // Newest measurement per video. Re-measuring produces a new artifact rather
  // than replacing one, so without this a video measured three times would
  // count three times and skew every median.
  const latest = new Map<string, { artifact: Artifact; createdAt: string }>();

  for (const row of rows) {
    const artifact = await store.get(row.artifact_id);
    if (!artifact) continue;
    const payload = artifact.payload as {
      external_id?: string;
      measured_at?: string;
    };
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
      metrics: WindowEpisode["metrics"] & { unavailable?: string[] };
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
        subscribers_gained: p.metrics.subscribers_gained,
        likes: p.metrics.likes,
        comments: p.metrics.comments,
      },
    });
  }

  // Newest first: recent episodes are the more relevant evidence.
  episodes.sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const kept = episodes.slice(0, maxEpisodes);

  const ctrs = kept
    .map((e) => e.metrics.click_through_rate)
    .filter((v): v is number => v !== null);

  return {
    generated_at: now().toISOString(),
    episode_count: kept.length,
    // False when no episode reported a click rate — the strategist is told not
    // to reason about thumbnails at all in that case.
    ctr_available: ctrs.length > 0,
    aggregates: {
      median_views: median(kept.map((e) => e.metrics.views)) ?? 0,
      median_view_percentage: round6(
        median(
          kept
            .map((e) => e.metrics.average_view_percentage)
            .filter((v): v is number => v !== null),
        ),
      ),
      median_ctr: round6(median(ctrs)),
      total_subscribers_gained: kept.reduce((n, e) => n + e.metrics.subscribers_gained, 0),
    },
    episodes: kept,
  };
}

/**
 * Walk up from a performance artifact to recover the decisions behind it.
 * Anything not found is simply omitted — an older episode published before the
 * SEO or thumbnail agents existed still contributes its numbers.
 */
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
      if (typeof payload["published_at"] === "string") {
        out.published_at = payload["published_at"];
      }
    } else if (a.schema_id === "seo_metadata") {
      if (typeof payload["primary_keyword"] === "string") {
        out.primary_keyword = payload["primary_keyword"];
      }
      // The SEO title is the one viewers actually saw, so it wins over the
      // copy denormalised onto the published_episode.
      if (typeof payload["title"] === "string") out.title = payload["title"];
    } else if (a.schema_id === "thumbnail") {
      if (typeof payload["text"] === "string") out.thumbnail_text = payload["text"];
    }
  }
  return out;
}
