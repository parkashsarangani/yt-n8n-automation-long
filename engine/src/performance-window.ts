/**
 * Builds the performance_window input artifact by joining measured outcomes to
 * the creative decisions that produced them. RFC 0009 decision 9 only becomes
 * a feedback loop when an outcome stays attached to the package/story choices
 * that caused it; title + keyword alone are not enough to learn about hooks,
 * emotional engines, first-30 structure, or pacing.
 */

import type { Artifact } from "./artifact.ts";
import type { ArtifactStore } from "./store.ts";

type PackageFamily = "curiosity" | "conflict" | "reversal";
type Genre = "moral_story" | "drama" | "true_story" | "short_story";

interface RetentionPoint {
  elapsed_ratio: number;
  audience_watch_ratio: number;
}

export interface RetentionEvent {
  kind: "spike" | "dip";
  elapsed_ratio: number;
  audience_watch_ratio: number;
  /** Change from the immediately preceding reported retention point. */
  delta: number;
}

export interface CreativeContext {
  package_artifact_id?: string;
  story_artifact_id?: string;
  premise?: string;
  target_audience?: string;
  curiosity_gap?: string;
  emotional_engine?: string;
  selected_title?: string;
  selected_title_family?: PackageFamily;
  selected_thumbnail_concept?: string;
  selected_thumbnail_family?: PackageFamily;
  opening_visual?: string;
  opening_line?: string;
  first_30_seconds?: {
    promise: string;
    zero_to_five: string;
    five_to_fifteen: string;
    fifteen_to_thirty: string;
  };
  package_scores?: {
    clickability: number;
    story_potential: number;
    audience_size: number;
  };
  genre?: Genre;
  image_style?: string;
  story_hook?: string;
  act_titles?: string[];
  retention_beats?: Array<{ at_fraction: number; device: string }>;
  next_video_bridge?: string;
}

export interface WindowEpisode {
  external_id: string;
  title?: string;
  primary_keyword?: string;
  thumbnail_text?: string;
  published_at?: string;
  window_days?: number;
  creative?: CreativeContext;
  metrics: {
    views: number;
    estimated_minutes_watched: number;
    average_view_duration_sec: number;
    average_view_percentage: number | null;
    impressions: number | null;
    click_through_rate: number | null;
    retention_5s: number | null;
    retention_15s: number | null;
    retention_30s: number | null;
    retention_events: RetentionEvent[];
    subscribers_gained: number;
    likes: number;
    comments: number;
    shares: number;
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
    median_average_view_duration_sec: number | null;
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

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isPackageFamily(value: unknown): value is PackageFamily {
  return value === "curiosity" || value === "conflict" || value === "reversal";
}

function isGenre(value: unknown): value is Genre {
  return value === "moral_story" || value === "drama" || value === "true_story" || value === "short_story";
}

/**
 * Retention reports can contain up to 200 points. Sending all of them into the
 * strategist for every episode is expensive and mostly noise. Preserve the
 * strongest sudden local changes instead: they are the points worth matching
 * back to a hook, act boundary, reveal, or other creative decision. A 4-point
 * change is deliberately a detection threshold, not a claim of causality.
 */
export function summarizeRetentionEvents(curve: RetentionPoint[] | null | undefined): RetentionEvent[] {
  if (!Array.isArray(curve) || curve.length < 2) return [];
  const points = curve
    .filter((p) => p && Number.isFinite(p.elapsed_ratio) && Number.isFinite(p.audience_watch_ratio))
    .sort((a, b) => a.elapsed_ratio - b.elapsed_ratio);
  const events: RetentionEvent[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    const delta = current.audience_watch_ratio - previous.audience_watch_ratio;
    if (Math.abs(delta) < 0.04) continue;
    events.push({
      kind: delta > 0 ? "spike" : "dip",
      elapsed_ratio: round6(current.elapsed_ratio)!,
      audience_watch_ratio: round6(current.audience_watch_ratio)!,
      delta: round6(delta)!,
    });
  }
  return events
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6)
    .sort((a, b) => a.elapsed_ratio - b.elapsed_ratio);
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
        estimated_minutes_watched?: number;
        average_view_duration_sec?: number;
        average_view_percentage?: number | null;
        impressions?: number | null;
        click_through_rate?: number | null;
        retention_curve?: RetentionPoint[] | null;
        retention_5s?: number | null;
        retention_15s?: number | null;
        retention_30s?: number | null;
        subscribers_gained: number;
        likes: number;
        comments: number;
        shares?: number;
      };
    };
    const context = await describeAncestors(store, artifact.artifact_id);
    episodes.push({
      external_id: p.external_id,
      ...context,
      ...(p.window?.days !== undefined ? { window_days: p.window.days } : {}),
      metrics: {
        views: p.metrics.views,
        estimated_minutes_watched: finiteOr(p.metrics.estimated_minutes_watched, 0),
        average_view_duration_sec: finiteOr(p.metrics.average_view_duration_sec, 0),
        average_view_percentage: p.metrics.average_view_percentage ?? null,
        impressions: typeof p.metrics.impressions === "number" ? p.metrics.impressions : null,
        click_through_rate: p.metrics.click_through_rate ?? null,
        retention_5s: p.metrics.retention_5s ?? null,
        retention_15s: p.metrics.retention_15s ?? null,
        retention_30s: p.metrics.retention_30s ?? null,
        retention_events: summarizeRetentionEvents(p.metrics.retention_curve),
        subscribers_gained: p.metrics.subscribers_gained,
        likes: p.metrics.likes,
        comments: p.metrics.comments,
        shares: finiteOr(p.metrics.shares, 0),
      },
    });
  }

  episodes.sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const kept = episodes.slice(0, maxEpisodes);
  const nonNull = (key: "click_through_rate" | "average_view_percentage" | "retention_5s" | "retention_15s" | "retention_30s"): number[] =>
    kept.map((e) => e.metrics[key]).filter((v): v is number => v !== null);
  const ctrs = kept
    .filter((e) => e.metrics.impressions !== null && e.metrics.click_through_rate !== null)
    .map((e) => e.metrics.click_through_rate as number);
  const r5 = nonNull("retention_5s");
  const r15 = nonNull("retention_15s");
  const r30 = nonNull("retention_30s");

  return {
    generated_at: now().toISOString(),
    episode_count: kept.length,
    ctr_available: ctrs.length > 0,
    retention_available: r5.length > 0 || r15.length > 0 || r30.length > 0 || kept.some((e) => e.metrics.retention_events.length > 0),
    aggregates: {
      median_views: median(kept.map((e) => e.metrics.views)) ?? 0,
      median_view_percentage: round6(median(nonNull("average_view_percentage"))),
      median_average_view_duration_sec: round6(median(kept.map((e) => e.metrics.average_view_duration_sec))),
      median_ctr: round6(median(ctrs)),
      median_retention_5s: round6(median(r5)),
      median_retention_15s: round6(median(r15)),
      median_retention_30s: round6(median(r30)),
      total_subscribers_gained: kept.reduce((n, e) => n + e.metrics.subscribers_gained, 0),
    },
    episodes: kept,
  };
}

function selectedFamily(payload: Record<string, unknown>, field: "title" | "thumbnail_concept", selected: unknown): PackageFamily | undefined {
  if (typeof selected !== "string" || !Array.isArray(payload["variants"])) return undefined;
  for (const raw of payload["variants"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const variant = raw as Record<string, unknown>;
    if (variant[field] === selected && isPackageFamily(variant["family"])) return variant["family"];
  }
  return undefined;
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

  const nearest = new Map<string, Artifact>();
  for (const a of ancestors) if (!nearest.has(a.schema_id)) nearest.set(a.schema_id, a);

  const published = nearest.get("published_episode");
  if (published) {
    const payload = published.payload as Record<string, unknown>;
    const title = text(payload["title"]); if (title) out.title = title;
    const publishedAt = text(payload["published_at"]); if (publishedAt) out.published_at = publishedAt;
  }
  const seo = nearest.get("seo_metadata");
  if (seo) {
    const payload = seo.payload as Record<string, unknown>;
    const keyword = text(payload["primary_keyword"]); if (keyword) out.primary_keyword = keyword;
    const title = text(payload["title"]); if (title) out.title = title;
  }
  const thumbnail = nearest.get("thumbnail");
  if (thumbnail) {
    const payload = thumbnail.payload as Record<string, unknown>;
    const thumbnailText = text(payload["text"]); if (thumbnailText) out.thumbnail_text = thumbnailText;
  }

  const creative: CreativeContext = {};
  const growthPackage = nearest.get("growth_package");
  if (growthPackage) {
    const payload = growthPackage.payload as Record<string, unknown>;
    creative.package_artifact_id = growthPackage.artifact_id;
    const assign = (key: keyof CreativeContext, value: unknown) => {
      const v = text(value);
      if (v) (creative as Record<string, unknown>)[key] = v;
    };
    assign("premise", payload["premise"]);
    assign("target_audience", payload["target_audience"]);
    assign("curiosity_gap", payload["curiosity_gap"]);
    assign("emotional_engine", payload["emotional_engine"]);
    assign("selected_title", payload["selected_title"]);
    assign("selected_thumbnail_concept", payload["selected_thumbnail_concept"]);
    assign("opening_visual", payload["opening_visual"]);
    assign("opening_line", payload["opening_line"]);
    assign("next_video_bridge", payload["next_video_bridge"]);

    const titleFamily = selectedFamily(payload, "title", payload["selected_title"]);
    if (titleFamily) creative.selected_title_family = titleFamily;
    const thumbnailFamily = selectedFamily(payload, "thumbnail_concept", payload["selected_thumbnail_concept"]);
    if (thumbnailFamily) creative.selected_thumbnail_family = thumbnailFamily;

    const first30 = payload["first_30_seconds"];
    if (first30 && typeof first30 === "object") {
      const f = first30 as Record<string, unknown>;
      const promise = text(f["promise"]), zero = text(f["zero_to_five"]), five = text(f["five_to_fifteen"]), fifteen = text(f["fifteen_to_thirty"]);
      if (promise && zero && five && fifteen) creative.first_30_seconds = { promise, zero_to_five: zero, five_to_fifteen: five, fifteen_to_thirty: fifteen };
    }
    const scores = payload["scores"];
    if (scores && typeof scores === "object") {
      const s = scores as Record<string, unknown>;
      if ([s["clickability"], s["story_potential"], s["audience_size"]].every((v) => typeof v === "number" && Number.isFinite(v))) {
        creative.package_scores = {
          clickability: s["clickability"] as number,
          story_potential: s["story_potential"] as number,
          audience_size: s["audience_size"] as number,
        };
      }
    }
  }

  const story = nearest.get("story");
  if (story) {
    const payload = story.payload as Record<string, unknown>;
    creative.story_artifact_id = story.artifact_id;
    if (isGenre(payload["genre"])) creative.genre = payload["genre"];
    const hook = text(payload["hook"]); if (hook) creative.story_hook = hook;
    if (Array.isArray(payload["acts"])) {
      const titles = (payload["acts"] as unknown[])
        .map((raw) => raw && typeof raw === "object" ? text((raw as Record<string, unknown>)["act_title"]) : undefined)
        .filter((v): v is string => Boolean(v))
        .slice(0, 6);
      if (titles.length) creative.act_titles = titles;
    }
    if (Array.isArray(payload["retention_beats"])) {
      const beats = (payload["retention_beats"] as unknown[]).flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const b = raw as Record<string, unknown>, at = b["at_fraction"], device = text(b["device"]);
        return typeof at === "number" && Number.isFinite(at) && device ? [{ at_fraction: at, device }] : [];
      }).slice(0, 20);
      if (beats.length) creative.retention_beats = beats;
    }
  }

  const intent = nearest.get("intent");
  if (intent) {
    const payload = intent.payload as Record<string, unknown>;
    if (!creative.genre && isGenre(payload["genre"])) creative.genre = payload["genre"];
    const style = text(payload["image_style"]); if (style) creative.image_style = style;
  }

  if (Object.keys(creative).length > 0) out.creative = creative;
  return out;
}
