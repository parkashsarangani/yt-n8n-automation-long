/**
 * Measure worker: published_episode -> episode_performance.
 * RFC 0009 adds negotiated audience-retention samples at 5/15/30 seconds.
 */
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import type { AnalyticsWindow, EpisodeMetrics } from "../provider.ts";

export interface MeasureWorkerOptions { windowDays?: number; now?: () => Date; version?: string }
interface PublishedEpisode { target: string; external_id: string; url?: string; published_at?: string }
export interface RetentionPoint { elapsed_ratio: number; audience_watch_ratio: number }
interface RetentionCapableAnalytics {
  id: string;
  fetchEpisodeMetrics(externalId: string, window: AnalyticsWindow): Promise<{ metrics: EpisodeMetrics }>;
  fetchAudienceRetention?: (externalId: string, window: AnalyticsWindow) => Promise<{ points: RetentionPoint[] | null; unavailable?: string }>;
}
const DAY_MS = 24 * 60 * 60 * 1000;
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function utcDay(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

export function effectiveAnalyticsWindow(
  now: Date,
  windowDays: number,
  publishedAt?: string,
): { window: AnalyticsWindow; days: number } {
  const endDate = utcDay(new Date(now.getTime() - DAY_MS));
  const requestedStart = new Date(endDate.getTime() - (windowDays - 1) * DAY_MS);
  let startDate = requestedStart;

  if (publishedAt) {
    const parsed = new Date(publishedAt);
    if (Number.isFinite(parsed.getTime())) {
      const publishedDay = utcDay(parsed);
      if (publishedDay.getTime() > endDate.getTime()) {
        throw new Error("published episode has no completed analytics day yet");
      }
      if (publishedDay.getTime() > startDate.getTime()) startDate = publishedDay;
    }
  }

  const days = Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1;
  return {
    window: { start_date: isoDate(startDate), end_date: isoDate(endDate) },
    days,
  };
}

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
    name: "measure", kind: "worker", version: opts.version ?? "2",
    consumes: [{ schema_id: "published_episode", range: "^1", as: "episode" }],
    produces: "episode_performance", produces_version: "2.0.0",
    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const episode = inputs["episode"]!.payload as PublishedEpisode;
      const analytics = ctx.media.analytics as RetentionCapableAnalytics | undefined;
      if (!analytics) throw new Error("measure worker needs an analytics provider; none was configured (analytics needs yt-analytics.readonly scope)");
      const end = now();
      const effective = effectiveAnalyticsWindow(end, windowDays, episode.published_at);
      const window = effective.window;
      await ctx.progress({ detail: `measuring ${episode.external_id} over ${effective.days}d (${window.start_date} → ${window.end_date})` });
      const { metrics } = await analytics.fetchEpisodeMetrics(episode.external_id, window);
      const unavailable = [...metrics.unavailable];
      let retentionCurve: RetentionPoint[] | null = null;
      if (analytics.fetchAudienceRetention) {
        try {
          const retention = await analytics.fetchAudienceRetention(episode.external_id, window);
          retentionCurve = retention.points;
          if (retention.unavailable) unavailable.push(retention.unavailable);
        } catch (err) {
          unavailable.push(`audience retention unavailable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240));
        }
      } else {
        unavailable.push("audience retention not supported by configured analytics provider");
      }
      const durationSec = inferDurationSec(metrics.average_view_duration_sec, metrics.average_view_percentage);
      if (metrics.unavailable.length > 0) ctx.logger.warn(`[measure] ${episode.external_id}: platform did not return ${metrics.unavailable.join("; ")}`);
      return {
        payload: {
          external_id: episode.external_id,
          ...(episode.url ? { url: episode.url } : {}),
          source: analytics.id,
          window: { ...window, days: effective.days },
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
            retention_curve: retentionCurve,
            retention_5s: retentionAtSecond(retentionCurve, 5, durationSec),
            retention_15s: retentionAtSecond(retentionCurve, 15, durationSec),
            retention_30s: retentionAtSecond(retentionCurve, 30, durationSec),
            unavailable,
          },
        },
      };
    },
  };
}
