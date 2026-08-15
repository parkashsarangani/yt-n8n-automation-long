/**
 * YouTube Analytics provider (RFC 0004).
 *
 * The only file that knows how YouTube reports numbers. Everything upstream
 * sees an AnalyticsProvider and an EpisodeMetrics shape.
 *
 * DISCOVERY METRICS ARE NEGOTIATED, NOT ASSUMED.
 *
 * Thumbnail impressions and click rate are the two numbers that actually say
 * whether a thumbnail earned its place, and their availability in the Analytics
 * API is genuinely unclear: they are widely reported as Studio-only, while a
 * January 2026 changelog is cited as adding `videoThumbnailImpressions` and
 * `videoThumbnailImpressionsClickRate`. The public metrics reference does not
 * currently list them.
 *
 * Rather than bet on either answer, the first request asks for them; if the API
 * rejects the query as an unknown metric, the provider retries with the core
 * set alone and records what it could not get. That is robust whichever way the
 * platform actually behaves, and the artifact ends up documenting the truth for
 * this channel instead of our guess about it.
 *
 * Requires the yt-analytics.readonly scope, which the upload scope does not
 * imply — a token minted before this existed will 403 here.
 */

import {
  ProviderError,
  type AnalyticsProvider,
  type AnalyticsWindow,
  type EpisodeMetrics,
  type Usage,
  type Visibility,
} from "../provider.ts";

const CORE_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "likes",
  "comments",
  "shares",
] as const;

/** Asked for, then dropped if the API says it does not know them. */
const DISCOVERY_METRICS = [
  "videoThumbnailImpressions",
  "videoThumbnailImpressionsClickRate",
] as const;

export interface YouTubeAnalyticsOptions {
  accessToken: string | (() => Promise<string>);
  baseUrl?: string;
  /** YouTube Data API, used only to read current visibility. */
  dataApiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ReportResponse {
  columnHeaders?: Array<{ name: string }>;
  rows?: Array<Array<number | string>>;
  error?: { message?: string };
}

export class YouTubeAnalyticsProvider implements AnalyticsProvider {
  readonly id = "youtube-analytics";
  private readonly token: () => Promise<string>;
  private readonly baseUrl: string;
  private readonly dataApiUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** Latched once the API tells us the discovery metrics are unknown. */
  private discoverySupported = true;

  constructor(opts: YouTubeAnalyticsOptions) {
    this.token =
      typeof opts.accessToken === "string"
        ? async () => opts.accessToken as string
        : opts.accessToken;
    this.baseUrl = opts.baseUrl ?? "https://youtubeanalytics.googleapis.com/v2";
    this.dataApiUrl = opts.dataApiUrl ?? "https://www.googleapis.com/youtube/v3";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Batched: videos.list takes up to 50 ids per call, so measuring a whole
   * channel costs a handful of requests rather than one per episode.
   */
  async fetchVisibility(externalIds: string[]): Promise<Record<string, Visibility>> {
    const out: Record<string, Visibility> = {};
    for (const id of externalIds) out[id] = "unknown";

    for (let i = 0; i < externalIds.length; i += 50) {
      const batch = externalIds.slice(i, i + 50);
      const url = new URL(`${this.dataApiUrl}/videos`);
      url.searchParams.set("part", "status");
      url.searchParams.set("id", batch.join(","));

      const res = await this.fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${await this.token()}` },
      });
      if (!res.ok) {
        // Unknown rather than a throw: not being able to check visibility must
        // not take down measurement, and "unknown" is excluded anyway.
        continue;
      }
      const body = (await res.json()) as {
        items?: Array<{ id?: string; status?: { privacyStatus?: string } }>;
      };
      for (const item of body.items ?? []) {
        const status = item.status?.privacyStatus;
        if (!item.id) continue;
        out[item.id] =
          status === "public" || status === "unlisted" || status === "private"
            ? status
            : "unknown";
      }
    }
    return out;
  }

  async fetchEpisodeMetrics(
    externalId: string,
    window: AnalyticsWindow,
  ): Promise<{ metrics: EpisodeMetrics; usage: Usage }> {
    const unavailable: string[] = [];

    let wanted: string[] = this.discoverySupported
      ? [...CORE_METRICS, ...DISCOVERY_METRICS]
      : [...CORE_METRICS];

    let row = await this.query(externalId, window, wanted);

    if (row === "unknown-metric") {
      // Latched so one rejection does not cost every later episode a wasted
      // round trip.
      this.discoverySupported = false;
      wanted = [...CORE_METRICS];
      unavailable.push(
        `${DISCOVERY_METRICS.join(", ")} (not supported by this API for this channel)`,
      );
      row = await this.query(externalId, window, wanted);
      if (row === "unknown-metric") {
        throw new ProviderError("youtube analytics rejected even the core metric set");
      }
    } else if (!this.discoverySupported) {
      unavailable.push(`${DISCOVERY_METRICS.join(", ")} (not supported)`);
    }

    const get = (name: string): number | null => {
      const v = row[name];
      return typeof v === "number" ? v : null;
    };

    return {
      metrics: {
        views: get("views") ?? 0,
        estimated_minutes_watched: get("estimatedMinutesWatched") ?? 0,
        average_view_duration_sec: get("averageViewDuration") ?? 0,
        average_view_percentage: get("averageViewPercentage"),
        subscribers_gained: get("subscribersGained") ?? 0,
        likes: get("likes") ?? 0,
        comments: get("comments") ?? 0,
        shares: get("shares") ?? 0,
        impressions: get("videoThumbnailImpressions"),
        // The API reports a click *rate* as a percentage; the artifact carries a
        // fraction, so the unit is unambiguous wherever it is read.
        click_through_rate: toFraction(get("videoThumbnailImpressionsClickRate")),
        unavailable,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0, // quota, not money
        provider: this.id,
        model: "youtube-analytics-v2",
      },
    };
  }

  /** One row keyed by metric name, or the sentinel for an unknown metric. */
  private async query(
    externalId: string,
    window: AnalyticsWindow,
    metrics: string[],
  ): Promise<Record<string, number | string> | "unknown-metric"> {
    const url = new URL(`${this.baseUrl}/reports`);
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", window.start_date);
    url.searchParams.set("endDate", window.end_date);
    url.searchParams.set("metrics", metrics.join(","));
    url.searchParams.set("filters", `video==${externalId}`);

    const res = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400 && /unknown metric|invalid metric|badRequest/i.test(text)) {
        return "unknown-metric";
      }
      if (res.status === 403) {
        // Two very different problems arrive as 403, and confusing them sends
        // the operator to re-authorize when the grant was never the issue.
        // Google distinguishes them with an error reason.
        if (/accessNotConfigured|has not been used in project/i.test(text)) {
          const project = /project (\d+)/.exec(text)?.[1];
          throw new ProviderError(
            "the YouTube Analytics API is not enabled on this Google Cloud project. " +
            "The OAuth grant is fine — the API itself has to be switched on: " +
            `https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview` +
            `${project ? `?project=${project}` : ""} — then wait a few minutes for it to propagate.`,
          );
        }
        throw new ProviderError(
          "youtube analytics returned 403 — the refresh token probably predates the " +
          "yt-analytics.readonly scope. Re-run `npm run youtube-auth` from engine/ to " +
          `re-authorize. (${text.slice(0, 200)})`,
        );
      }
      throw new ProviderError(
        `youtube analytics failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }

    const body = (await res.json()) as ReportResponse;
    const headers = (body.columnHeaders ?? []).map((h) => h.name);
    // No rows means the video exists but has no data in the window — a real
    // answer (zero), not a failure.
    const values = body.rows?.[0] ?? headers.map(() => 0);

    const row: Record<string, number | string> = {};
    headers.forEach((name, i) => {
      row[name] = values[i] ?? 0;
    });
    return row;
  }
}

/**
 * YouTube reports click rate as a percentage; downstream wants 0..1.
 *
 * Rounded to six places because the division is lossy: 5.8 / 100 is
 * 0.057999999999999996 in binary floating point. Six decimals is far finer
 * than any meaningful CTR difference, and it keeps the value the API actually
 * reported rather than an artefact of the conversion — which matters here,
 * since this number ends up inside a content-addressed artifact.
 */
function toFraction(pct: number | null): number | null {
  if (pct === null) return null;
  const fraction = pct > 1 ? pct / 100 : pct;
  return Math.round(fraction * 1e6) / 1e6;
}
