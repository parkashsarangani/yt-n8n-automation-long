/**
 * Measure worker: published_episode -> episode_performance.
 *
 * Observations only. Interpretation belongs to channel_strategist. RFC 0009
 * adds a negotiated audience-retention report because first-5/15/30-second
 * behavior is now an explicit editorial feedback signal. Missing platform data
 * is recorded as unavailable/null, never as zero.
 */

import type { AnalyticsProvider } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface MeasureWorkerOptions {
  windowDays?: number;
  now?: () => Date;
  version?: string;
}

interface PublishedEpisode {
  target: string;
  external_id: string;
  url?: string;
  published_at?: string;
}

interface RetentionPoint {
  elapsed_ratio: number;
  audience_watch_ratio: number;
}

interface RetentionCapableAnalytics extends AnalyticsProvider {
  fetchAudienceRetention?: (
    externalId: string,
    window: { start_date: string; end_date: string },
  ) => Promise<{ points: RetentionPoint[] | null; unavailable?: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * averageViewPercentage is defined against full video duration, so together
 * with averageViewDuration it gives us the video's effective duration without
 * adding another YouTube Data API call. This is used only to map 5/15/30 sec
 * onto elapsedVideoTimeRatio; if either input is unavailable, the curve is
 * still preserved and the second-based samples stay null.
 */
export function inferDurationSec(averageViewDurationSec: number, averageViewPercentage: number | null): number | null {
  if (!Number.isFinite(averageViewDurationSec) || averageViewDurationSec <= 0) return null;
  if (averageViewPercentage === null || !Number.isFinite(averageViewPercentage) || averageViewPercentage <= 0) return null;
  const duration = averageViewDurationSec / (averageViewPercentage / 100);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function retentionAtSecond(points: RetentionPoint[] | null, second: number, durationSec: number | null): number | null {
  if (!points?.length || durationSec === null || durationSec <= 0 || second < 0 || second > durationSec) return null;
  const target = Math.max(0, Math.min(1, second / durationSec));
  let best = points[0]!;
  let distance = Math.abs(best.elapsed_ratio - target);
  for (const point of points.slice(1)) {
    const d = Math.abs(point.elapsed_ratio - target);
    if (d < distance) { best = point; distance = d; }
  }
  return Math.round(best.audience_watch_ratio * 1e6) / 1e6;
}

export function makeMeasureWorker(opts: MeasureWorkerOptions = {}): WorkerDef {
  const windowDays = opts.windowDays ?? 28;
  const now = opts.now ?? (() => new Date());

  return {
    name: "measure",
    kind: "worker",
    version: opts.version ?? "2",
    consumes: [{ schema_id: "published_episode", range: "^1", as: "episode" }],
    produces: "episode_performance",
    produces_version: "1.1.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const episode = inputs["episode"]!.payload as PublishedEpisode;
      const analytics = ctx.media.analytics as RetentionCapableAnalytics | undefined;
      if (!analytics) {
        throw new Error(
          "measure worker needs an analytics provider; none was configured " +
          "(publishing credentials alone are not enough — analytics needs the yt-analytics.readonly scope)",
        );
      }

      const end = now();
      const endDate = new Date(end.getTime() - DAY_MS);
      const startDate = new Date(endDate.getTime() - (windowDays - 1) * DAY_MS);
      const window = { start_date: isoDate(startDate), end_date: isoDate(endDate) };

      await ctx.progress({ detail: `measuring ${episode.external_id} over ${windowDays}d (${window.start_date} → ${window.end_date})` });

      const { metrics } = await analytics.fetchEpisodeMetrics(episode.external_id, window);
      const unavailable = [...metrics.unavailable];

      let retention: RetentionPoint[] | null = null;
      if (analytics.fetchAudienceRetention) {
        try {
          const result = await analytics.fetchAudienceRetention(episode.external_id, window);
          retention = result.points;
          if (result.unavailable) unavailable.push(result.unavailable);
        } catch (err) {
          unavailable.push(`audience retention (${err instanceof Error ? err.message : String(err)})`);
        }
      } else {
        unavailable.push("audience retention (provider does not expose retention report)");
      }

      if (unavailable.length > 0) {
        ctx.logger.warn(`[measure] ${episode.external_id}: platform did not return ${unavailable.join("; ")}`);
      }

      const durationSec = inferDurationSec(metrics.average_view_duration_sec, metrics.average_view_percentage);

      return {
        payload: {
          external_id: episode.external_id,
          ...(episode.url ? { url: episode.url } : {}),
          source: analytics.id,
          window: { ...window, days: windowDays },
          measured_at: end.toISOString(),
          metrics: {
            views: Math.round(metrics.views),
            estimated_minutes_watched: metrics.estimated_minutes_watched,
            average_view_duration_sec: metrics.average_view_duration_sec,
            average_view_percentage: metrics.average_view_percentage,
            subscribers_gained: Math.round(metrics.subscribers_gained),
            likes: Math.round(metrics.likes),
            comments: Math.round(metrics.comments),
            shares: Math.round(metrics.shares),
            impressions: metrics.impressions === null ? null : Math.round(metrics.impressions),
            click_through_rate: metrics.click_through_rate,
            retention_curve: retention,
            retention_5s: retentionAtSecond(retention, 5, durationSec),
            retention_15s: retentionAtSecond(retention, 15, durationSec),
            retention_30s: retentionAtSecond(retention, 30, durationSec),
            unavailable,
          },
        },
      };
    },
  };
}
