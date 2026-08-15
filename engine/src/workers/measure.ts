/**
 * Measure worker: published_episode -> episode_performance.
 *
 * A worker, not an agent: it reads numbers off a platform. It does not decide
 * what they mean — that is the insights agent's job, and keeping the two apart
 * is what stops "the data" and "the opinion about the data" becoming one
 * unauditable blob.
 *
 * This runs on its own graph, days after publishing. A video measured an hour
 * after upload tells you nothing, so measurement is deliberately detached from
 * the production run rather than tacked onto the end of it.
 *
 * Each measurement is a new artifact. Re-measuring the same episode over a
 * longer window does not overwrite the earlier one, so how a video aged stays
 * inspectable instead of being flattened into a single current number.
 */

import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface MeasureWorkerOptions {
  /** Days back from today. 28 matches YouTube's own default reporting window. */
  windowDays?: number;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  version?: string;
}

interface PublishedEpisode {
  target: string;
  external_id: string;
  url?: string;
  published_at?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** YouTube wants YYYY-MM-DD in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function makeMeasureWorker(opts: MeasureWorkerOptions = {}): WorkerDef {
  const windowDays = opts.windowDays ?? 28;
  const now = opts.now ?? (() => new Date());

  return {
    name: "measure",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [{ schema_id: "published_episode", range: "^1", as: "episode" }],
    produces: "episode_performance",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const episode = inputs["episode"]!.payload as PublishedEpisode;

      const analytics = ctx.media.analytics;
      if (!analytics) {
        throw new Error(
          "measure worker needs an analytics provider; none was configured " +
          "(publishing credentials alone are not enough — analytics needs the " +
          "yt-analytics.readonly scope)",
        );
      }

      const end = now();
      // Measure up to yesterday: the current day is always partial, and a
      // half-day of data silently drags every average down.
      const endDate = new Date(end.getTime() - DAY_MS);
      const startDate = new Date(endDate.getTime() - (windowDays - 1) * DAY_MS);

      const window = { start_date: isoDate(startDate), end_date: isoDate(endDate) };

      await ctx.progress({
        detail: `measuring ${episode.external_id} over ${windowDays}d (${window.start_date} → ${window.end_date})`,
      });

      const { metrics } = await analytics.fetchEpisodeMetrics(episode.external_id, window);

      if (metrics.unavailable.length > 0) {
        // Not a failure, but it bounds what any downstream conclusion can claim.
        ctx.logger.warn(
          `[measure] ${episode.external_id}: platform did not return ${metrics.unavailable.join("; ")}`,
        );
      }

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
            unavailable: metrics.unavailable,
          },
        },
      };
    },
  };
}
