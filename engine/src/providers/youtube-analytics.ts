/**
 * YouTube Analytics provider (RFC 0004 + RFC 0009).
 *
 * Basic/discovery metrics are negotiated because thumbnail impressions/CTR
 * may not be exposed for every channel. RFC 0009 additionally queries the
 * documented audience-retention report separately: dimensions=
 * elapsedVideoTimeRatio, metrics=audienceWatchRatio, filter=one video.
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

const DISCOVERY_METRICS = [
  "videoThumbnailImpressions",
  "videoThumbnailImpressionsClickRate",
] as const;

export interface YouTubeAnalyticsOptions {
  accessToken: string | (() => Promise<string>);
  baseUrl?: string;
  dataApiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ReportResponse {
  columnHeaders?: Array<{ name: string }>;
  rows?: Array<Array<number | string>>;
  error?: { message?: string };
}

export interface AudienceRetentionPoint {
  elapsed_ratio: number;
  audience_watch_ratio: number;
}

export class YouTubeAnalyticsProvider implements AnalyticsProvider {
  readonly id = "youtube-analytics";
  private readonly token: () => Promise<string>;
  private readonly baseUrl: string;
  private readonly dataApiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private discoverySupported = true;
  private retentionSupported = true;

  constructor(opts: YouTubeAnalyticsOptions) {
    this.token = typeof opts.accessToken === "string"
      ? async () => opts.accessToken as string
      : opts.accessToken;
    this.baseUrl = opts.baseUrl ?? "https://youtubeanalytics.googleapis.com/v2";
    this.dataApiUrl = opts.dataApiUrl ?? "https://www.googleapis.com/youtube/v3";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

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
      if (!res.ok) continue;
      const body = (await res.json()) as {
        items?: Array<{ id?: string; status?: { privacyStatus?: string } }>;
      };
      for (const item of body.items ?? []) {
        const status = item.status?.privacyStatus;
        if (!item.id) continue;
        out[item.id] = status === "public" || status === "unlisted" || status === "private"
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
      this.discoverySupported = false;
      wanted = [...CORE_METRICS];
      unavailable.push(`${DISCOVERY_METRICS.join(", ")} (not supported by this API for this channel)`);
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
        click_through_rate: toFraction(get("videoThumbnailImpressionsClickRate")),
        unavailable,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0,
        provider: this.id,
        model: "youtube-analytics-v2",
      },
    };
  }

  /**
   * Official YouTube Analytics audience-retention report. This is a separate
   * report shape from the ordinary per-video aggregate metrics and therefore
   * cannot be appended to CORE_METRICS. Unsupported/insufficient-data results
   * are negotiated once and returned as unavailable rather than throwing on
   * every later episode.
   */
  async fetchAudienceRetention(
    externalId: string,
    window: AnalyticsWindow,
  ): Promise<{ points: AudienceRetentionPoint[] | null; unavailable?: string }> {
    if (!this.retentionSupported) {
      return { points: null, unavailable: "audienceWatchRatio/elapsedVideoTimeRatio (not supported for this channel)" };
    }

    const url = new URL(`${this.baseUrl}/reports`);
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", window.start_date);
    url.searchParams.set("endDate", window.end_date);
    url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
    url.searchParams.set("metrics", "audienceWatchRatio");
    url.searchParams.set("filters", `video==${externalId}`);

    const res = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400 && /unknown metric|invalid metric|badRequest|unsupported|not available/i.test(text)) {
        this.retentionSupported = false;
        return { points: null, unavailable: "audienceWatchRatio/elapsedVideoTimeRatio (API rejected retention report)" };
      }
      if (res.status === 403) {
        throw new ProviderError(`youtube audience retention returned 403: ${text.slice(0, 220)}`);
      }
      throw new ProviderError(`youtube audience retention failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const body = (await res.json()) as ReportResponse;
    const headers = (body.columnHeaders ?? []).map((h) => h.name);
    const ratioIndex = headers.indexOf("elapsedVideoTimeRatio");
    const watchIndex = headers.indexOf("audienceWatchRatio");
    if (ratioIndex < 0 || watchIndex < 0) {
      return { points: null, unavailable: "audience retention report returned no expected columns" };
    }

    const points: AudienceRetentionPoint[] = [];
    for (const row of body.rows ?? []) {
      const ratio = row[ratioIndex];
      const watch = row[watchIndex];
      if (typeof ratio !== "number" || typeof watch !== "number") continue;
      if (!Number.isFinite(ratio) || !Number.isFinite(watch)) continue;
      points.push({
        elapsed_ratio: Math.max(0, Math.min(1, ratio)),
        audience_watch_ratio: Math.max(0, watch),
      });
    }
    points.sort((a, b) => a.elapsed_ratio - b.elapsed_ratio);
    return points.length > 0
      ? { points }
      : { points: null, unavailable: "audience retention report returned no rows in this window" };
  }

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
      throw new ProviderError(`youtube analytics failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const body = (await res.json()) as ReportResponse;
    const headers = (body.columnHeaders ?? []).map((h) => h.name);
    const values = body.rows?.[0] ?? headers.map(() => 0);

    const row: Record<string, number | string> = {};
    headers.forEach((name, i) => { row[name] = values[i] ?? 0; });
    return row;
  }
}

function toFraction(pct: number | null): number | null {
  if (pct === null) return null;
  const fraction = pct > 1 ? pct / 100 : pct;
  return Math.round(fraction * 1e6) / 1e6;
}
