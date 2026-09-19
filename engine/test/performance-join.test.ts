/**
 * The feedback loop the project's definition of done requires and has never
 * had: a measured retention number on the same row as the prompt version that
 * wrote the script and the renderer that cut the episode.
 *
 * The lineage is not direct -- measurement runs under its own run id, so the
 * production run has to be recovered through the published_episode the
 * performance artifact descends from. That indirection is what these tests
 * mostly guard.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  joinPerformance,
  cohortByPrompt,
  runProvenance,
  type JoinArtifact,
} from "../src/performance-join.ts";

function artifact(
  artifact_id: string,
  schema_id: string,
  payload: unknown,
  produced_by: JoinArtifact["produced_by"] = null,
  parents: string[] = [],
): JoinArtifact {
  return { artifact_id, schema_id, payload, parents, produced_by };
}

/** One complete episode: script -> render -> publish -> measure. */
function episode(opts: {
  run: string;
  externalId: string;
  scriptPrompt: string;
  packagePrompt?: string;
  renderer?: string;
  retention30?: number | null;
  ctr?: number | null;
  measuredAt?: string;
}): JoinArtifact[] {
  const { run, externalId, scriptPrompt } = opts;
  return [
    artifact(`sha256:script-${run}`, "script", { scenes: [] }, {
      transformation: "narration_script_writer", run_id: run, prompt_ref: scriptPrompt,
    }),
    artifact(`sha256:package-${run}`, "growth_package", {}, {
      transformation: "growth_packager", run_id: run, prompt_ref: opts.packagePrompt ?? "growth_packager@9",
    }),
    artifact(`sha256:video-${run}`, "rendered_video", { renderer: opts.renderer ?? "compositor" }, {
      transformation: "finalize_video", run_id: run,
    }),
    artifact(`sha256:published-${run}`, "published_episode", { external_id: externalId }, {
      transformation: "publish", run_id: run,
    }),
    artifact(
      `sha256:perf-${run}`,
      "episode_performance",
      {
        external_id: externalId,
        url: `https://www.youtube.com/watch?v=${externalId}`,
        measured_at: opts.measuredAt ?? "2026-09-19T00:00:00.000Z",
        window: { days: 28 },
        metrics: {
          views: 100,
          impressions: 2000,
          click_through_rate: opts.ctr ?? 0.05,
          average_view_duration_sec: 60,
          average_view_percentage: 33,
          retention_30s: opts.retention30 ?? 0.7,
          retention_curve: [{ elapsed_ratio: 0, audience_watch_ratio: 1 }],
          unavailable: [],
        },
      },
      // Measurement runs under its OWN run id -- the production run must not
      // be read from here.
      { transformation: "measure", run_id: `run_measure_${run}` },
      [`sha256:published-${run}`],
    ),
  ];
}

test("a measured episode carries the prompt versions of the run that made it", () => {
  const rows = joinPerformance(episode({
    run: "run_a", externalId: "vidA", scriptPrompt: "narration_script_writer@15",
    packagePrompt: "growth_packager@11", renderer: "editor",
  }));

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  // Not run_measure_run_a: the production run, recovered via published_episode.
  assert.equal(row.run_id, "run_a");
  assert.equal(row.prompts["narration_script_writer"], "narration_script_writer@15");
  assert.equal(row.prompts["growth_packager"], "growth_packager@11");
  assert.equal(row.renderer, "editor");
  assert.equal(row.retention_30s, 0.7);
  assert.equal(row.click_through_rate, 0.05);
  assert.equal(row.retention_curve_points, 1);
});

test("an editor cut supersedes the pipeline draft from the same run", () => {
  // Both exist in a real run: the compositor draft, then the editor's cut.
  const artifacts = episode({ run: "run_b", externalId: "vidB", scriptPrompt: "narration_script_writer@15" });
  artifacts.push(
    artifact("sha256:video-run_b-editor", "rendered_video", { renderer: "editor" }, {
      transformation: "finalize_video", run_id: "run_b",
    }),
  );
  assert.equal(runProvenance(artifacts).get("run_b")!.renderer, "editor");
  assert.equal(joinPerformance(artifacts)[0]!.renderer, "editor");
});

test("only the most recent measurement of an episode is kept", () => {
  const artifacts = episode({
    run: "run_c", externalId: "vidC", scriptPrompt: "narration_script_writer@13",
    measuredAt: "2026-09-01T00:00:00.000Z", retention30: 0.4,
  });
  artifacts.push(artifact(
    "sha256:perf-run_c-2",
    "episode_performance",
    {
      external_id: "vidC",
      measured_at: "2026-09-18T00:00:00.000Z",
      window: { days: 28 },
      metrics: { retention_30s: 0.8, unavailable: [] },
    },
    { transformation: "measure", run_id: "run_measure_2" },
    ["sha256:published-run_c"],
  ));

  const rows = joinPerformance(artifacts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.retention_30s, 0.8);
});

test("an unmeasurable episode still produces a row rather than vanishing", () => {
  // Nulls are the honest representation of "the platform did not say".
  const artifacts = episode({ run: "run_d", externalId: "vidD", scriptPrompt: "narration_script_writer@15" });
  artifacts[4] = artifact(
    "sha256:perf-run_d",
    "episode_performance",
    {
      external_id: "vidD",
      measured_at: "2026-09-19T00:00:00.000Z",
      metrics: { impressions: null, click_through_rate: null, unavailable: ["impressions", "ctr"] },
    },
    { transformation: "measure", run_id: "run_measure_d" },
    ["sha256:published-run_d"],
  );

  const row = joinPerformance(artifacts)[0]!;
  assert.equal(row.impressions, null);
  assert.equal(row.click_through_rate, null);
  assert.equal(row.retention_30s, null);
  assert.deepEqual(row.unavailable, ["impressions", "ctr"]);
});

test("a performance artifact with no published parent keeps its metrics but admits it has no provenance", () => {
  const orphan = [artifact(
    "sha256:perf-orphan",
    "episode_performance",
    { external_id: "vidE", measured_at: "2026-09-19T00:00:00.000Z", metrics: { retention_30s: 0.6 } },
    { transformation: "measure", run_id: "run_measure_e" },
    [],
  )];
  const row = joinPerformance(orphan)[0]!;
  assert.equal(row.run_id, null);
  assert.deepEqual(row.prompts, {});
  assert.equal(row.renderer, null);
  assert.equal(row.retention_30s, 0.6);
});

test("cohorts report the episode count alongside the median so small n is visible", () => {
  const artifacts = [
    ...episode({ run: "r1", externalId: "v1", scriptPrompt: "narration_script_writer@13", retention30: 0.50 }),
    ...episode({ run: "r2", externalId: "v2", scriptPrompt: "narration_script_writer@13", retention30: 0.70 }),
    ...episode({ run: "r3", externalId: "v3", scriptPrompt: "narration_script_writer@13", retention30: 0.60 }),
    ...episode({ run: "r4", externalId: "v4", scriptPrompt: "narration_script_writer@15", retention30: 0.90 }),
  ];
  const cohorts = cohortByPrompt(joinPerformance(artifacts), "narration_script_writer");

  const thirteen = cohorts.find((c) => c.key === "narration_script_writer@13")!;
  const fifteen = cohorts.find((c) => c.key === "narration_script_writer@15")!;
  assert.equal(thirteen.episodes, 3);
  assert.equal(thirteen.median_retention_30s, 0.60, "median, not mean");
  // The cohort of one must be legible as a cohort of one, not a verdict.
  assert.equal(fifteen.episodes, 1);
  assert.equal(fifteen.median_retention_30s, 0.90);
});

test("episodes missing a prompt ref group under unknown rather than being dropped", () => {
  const artifacts = episode({ run: "r5", externalId: "v5", scriptPrompt: "narration_script_writer@15" });
  artifacts[0] = artifact("sha256:script-r5", "script", {}, { transformation: "human", run_id: "r5" });
  const cohorts = cohortByPrompt(joinPerformance(artifacts), "narration_script_writer");
  assert.equal(cohorts.length, 1);
  assert.equal(cohorts[0]!.key, "unknown");
  assert.equal(cohorts[0]!.episodes, 1);
});
