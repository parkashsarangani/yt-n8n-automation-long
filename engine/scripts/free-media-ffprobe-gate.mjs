/**
 * ffprobe GATE for the Free Media Bake-off.
 *
 * Runs on the workflow host after `free-media-smoke.ts` has written the raw
 * videos + `media-bakeoff-report.json`. For every `video-*.mp4` it demands a
 * real, playable video: a video stream, a supported codec, non-zero duration
 * within sane bounds, and sane dimensions. It rewrites each video attempt's
 * `quality` / `promotable` in the report and EXITS NON-ZERO when a video that
 * the smoke marked AVAILABLE + FREE fails the gate — so bogus bytes can never
 * be silently promoted to a production video model.
 *
 *   node scripts/free-media-ffprobe-gate.mjs <bakeoff-dir>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error(`[ffprobe-gate] bake-off directory not found: ${dir}`);
  process.exit(1);
}

const SUPPORTED_CODECS = new Set(["h264", "hevc", "vp9", "av1", "mpeg4"]);
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 120;
const MIN_DIMENSION = 240;

const reportPath = path.join(dir, "media-bakeoff-report.json");
if (!existsSync(reportPath)) {
  console.error(`[ffprobe-gate] ${reportPath} not found — the smoke step did not produce a report`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));
// The REPORT is authoritative: every video attempt the smoke recorded as
// AVAILABLE + FREE + status=success must have a real, decodable artifact.
const videoAttempts = (report.attempts ?? []).filter((a) => a.modality === "video");

function probe(file) {
  try {
    const raw = execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
      encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    });
    const j = JSON.parse(raw);
    const v = (j.streams ?? []).find((s) => s.codec_type === "video");
    if (!v) return { ok: false, reason: "no video stream" };
    const duration = Number(j.format?.duration ?? v.duration ?? 0);
    const width = Number(v.width ?? 0);
    const height = Number(v.height ?? 0);
    const codec = String(v.codec_name ?? "");
    const problems = [];
    if (!SUPPORTED_CODECS.has(codec)) problems.push(`unsupported codec ${codec || "?"}`);
    if (!(duration >= MIN_DURATION_SEC && duration <= MAX_DURATION_SEC)) problems.push(`duration ${duration}s out of [${MIN_DURATION_SEC}, ${MAX_DURATION_SEC}]`);
    if (!(width >= MIN_DIMENSION && height >= MIN_DIMENSION)) problems.push(`dimensions ${width}x${height} too small`);
    return { ok: problems.length === 0, reason: problems.join("; "), codec, duration, width, height };
  } catch (err) {
    return { ok: false, reason: `ffprobe failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}

let hardFailures = 0;
const results = [];

for (const attempt of videoAttempts) {
  const expectedFree = attempt.status === "success" && attempt.availability === "AVAILABLE" && attempt.cost === "FREE";
  const file = attempt.artifact;
  let r;
  if (!file) {
    r = { ok: false, reason: attempt.status === "success" ? "report claims success but no artifact was written" : "no artifact (attempt did not succeed)" };
  } else {
    const full = path.join(dir, file);
    if (!existsSync(full) || statSync(full).size === 0) {
      r = { ok: false, reason: `declared artifact ${file} is missing or empty` };
    } else {
      r = probe(full);
    }
  }
  results.push({ requested_model: attempt.requested_model, file: file ?? null, expected_free: expectedFree, ...r });

  attempt.codec = r.codec ?? null;
  attempt.duration_sec = r.duration ?? attempt.duration_sec ?? null;
  attempt.width = r.width ?? attempt.width ?? null;
  attempt.height = r.height ?? attempt.height ?? null;
  attempt.quality = r.ok ? "PASS" : "FAIL";
  attempt.promotable = r.ok && expectedFree;
  if (!r.ok && expectedFree) {
    attempt.failure_reason = `ffprobe gate: ${r.reason}`;
    hardFailures += 1;
  }
  console.log(`[ffprobe-gate] ${attempt.requested_model} (${file ?? "no artifact"}): ${r.ok ? "PASS" : "FAIL"}${r.reason ? ` (${r.reason})` : ""}`);
}

report.ffprobe_gate = { checked: videoAttempts.length, results, hard_failures: hardFailures };
writeFileSync(reportPath, JSON.stringify(report, null, 2));
writeFileSync(path.join(dir, "ffprobe-gate.json"), JSON.stringify(results, null, 2));

if (videoAttempts.length === 0) {
  console.log("[ffprobe-gate] the report declared no video attempts");
}
if (hardFailures > 0) {
  console.error(`[ffprobe-gate] ${hardFailures} video(s) the smoke recorded as free+available did not pass decode validation`);
  process.exit(1);
}
