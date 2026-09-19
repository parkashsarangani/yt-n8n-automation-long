/**
 * Join measured YouTube performance back to what produced it.
 *
 * The pieces already existed and were never connected: episode_performance
 * carries impressions, CTR and a full retention curve; every artifact records
 * the run that produced it and the prompt version that produced it. What was
 * missing is the row that puts them on the same line, so a retention number
 * can be attributed to a script prompt, a packaging prompt, and whether a
 * human editor cut the episode or the pipeline rendered it.
 *
 * Why that attribution matters more than the averages: the editor re-cuts the
 * visual treatment, so retention is confounded by decisions the pipeline does
 * not control. A comparison that ignores which cut shipped is measuring the
 * editor as much as the prompt.
 *
 * Deliberately a pure function over artifacts. Nothing here calls YouTube or
 * the store, so it is testable without either, and it is read-only by
 * construction -- this reports on the archive, it never writes to it.
 */

export interface JoinArtifact {
  artifact_id: string;
  schema_id: string;
  payload: unknown;
  parents?: string[] | null;
  produced_by?: {
    transformation?: string;
    run_id?: string;
    prompt_ref?: string;
    provider?: string | null;
  } | null;
}

export interface JoinedEpisode {
  external_id: string;
  url: string | null;
  /** The production run, recovered through the published_episode artifact. */
  run_id: string | null;
  /** "editor" when a human cut it, the renderer id when the pipeline did. */
  renderer: string | null;
  /** transformation -> prompt_ref, for every prompt-driven agent in the run. */
  prompts: Record<string, string>;
  measured_at: string | null;
  window_days: number | null;
  views: number | null;
  impressions: number | null;
  click_through_rate: number | null;
  average_view_duration_sec: number | null;
  average_view_percentage: number | null;
  retention_5s: number | null;
  retention_15s: number | null;
  retention_30s: number | null;
  /** Present so a caller can plot the shape, not just the samples. */
  retention_curve_points: number | null;
  /** Anything the platform declined to return, carried through verbatim. */
  unavailable: string[];
}

type PerformancePayload = {
  external_id?: unknown;
  url?: unknown;
  measured_at?: unknown;
  window?: { days?: unknown } | null;
  metrics?: Record<string, unknown> | null;
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Per-run provenance: which prompt version each agent used, and which renderer
 * produced the video that shipped.
 */
export function runProvenance(artifacts: JoinArtifact[]): Map<string, { prompts: Record<string, string>; renderer: string | null }> {
  const byRun = new Map<string, { prompts: Record<string, string>; renderer: string | null }>();
  for (const artifact of artifacts) {
    const runId = artifact.produced_by?.run_id;
    if (!runId) continue;
    const entry = byRun.get(runId) ?? { prompts: {}, renderer: null };

    const promptRef = artifact.produced_by?.prompt_ref;
    const transformation = artifact.produced_by?.transformation;
    if (promptRef && transformation) entry.prompts[transformation] = promptRef;

    if (artifact.schema_id === "rendered_video") {
      const renderer = str((artifact.payload as { renderer?: unknown } | null)?.renderer);
      // An editor cut supersedes the pipeline draft from the same run: it is
      // the one that actually shipped.
      if (renderer === "editor" || entry.renderer === null) entry.renderer = renderer;
    }

    byRun.set(runId, entry);
  }
  return byRun;
}

/**
 * One row per measured episode, newest measurement first. An episode measured
 * more than once keeps only its most recent reading.
 */
export function joinPerformance(artifacts: JoinArtifact[]): JoinedEpisode[] {
  const byId = new Map(artifacts.map((a) => [a.artifact_id, a]));
  const provenance = runProvenance(artifacts);

  const rows: JoinedEpisode[] = [];
  for (const artifact of artifacts) {
    if (artifact.schema_id !== "episode_performance") continue;
    const payload = (artifact.payload ?? {}) as PerformancePayload;
    const externalId = str(payload.external_id);
    if (!externalId) continue;

    // The production run is not on the performance artifact -- measurement
    // runs under its own run id -- so it is recovered through the
    // published_episode this measurement descends from.
    let runId: string | null = null;
    for (const parentId of artifact.parents ?? []) {
      const parent = byId.get(parentId);
      if (parent?.schema_id === "published_episode") {
        runId = str(parent.produced_by?.run_id);
        break;
      }
    }

    const provenanceEntry = runId ? provenance.get(runId) : undefined;
    const metrics = (payload.metrics ?? {}) as Record<string, unknown>;
    const curve = metrics["retention_curve"];

    rows.push({
      external_id: externalId,
      url: str(payload.url),
      run_id: runId,
      renderer: provenanceEntry?.renderer ?? null,
      prompts: provenanceEntry?.prompts ?? {},
      measured_at: str(payload.measured_at),
      window_days: num(payload.window?.days),
      views: num(metrics["views"]),
      impressions: num(metrics["impressions"]),
      click_through_rate: num(metrics["click_through_rate"]),
      average_view_duration_sec: num(metrics["average_view_duration_sec"]),
      average_view_percentage: num(metrics["average_view_percentage"]),
      retention_5s: num(metrics["retention_5s"]),
      retention_15s: num(metrics["retention_15s"]),
      retention_30s: num(metrics["retention_30s"]),
      retention_curve_points: Array.isArray(curve) ? curve.length : null,
      unavailable: Array.isArray(metrics["unavailable"])
        ? (metrics["unavailable"] as unknown[]).filter((u): u is string => typeof u === "string")
        : [],
    });
  }

  rows.sort((a, b) => (b.measured_at ?? "").localeCompare(a.measured_at ?? ""));
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.external_id)) return false;
    seen.add(row.external_id);
    return true;
  });
}

export interface CohortSummary {
  key: string;
  episodes: number;
  /** Null when no episode in the cohort reported the metric. */
  median_retention_30s: number | null;
  median_click_through_rate: number | null;
  median_average_view_percentage: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Group rows by one agent's prompt version.
 *
 * Median rather than mean, and the episode count is returned alongside so a
 * cohort of two is never read as a result. At the volumes this channel
 * produces, the honest answer will usually be "not enough episodes yet" --
 * that is a finding, not a failure of the report.
 */
export function cohortByPrompt(rows: JoinedEpisode[], transformation: string): CohortSummary[] {
  const groups = new Map<string, JoinedEpisode[]>();
  for (const row of rows) {
    const key = row.prompts[transformation] ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      episodes: group.length,
      median_retention_30s: median(group.map((r) => r.retention_30s).filter((v): v is number => v !== null)),
      median_click_through_rate: median(group.map((r) => r.click_through_rate).filter((v): v is number => v !== null)),
      median_average_view_percentage: median(
        group.map((r) => r.average_view_percentage).filter((v): v is number => v !== null),
      ),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
