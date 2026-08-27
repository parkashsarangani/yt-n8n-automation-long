const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const ffmpeg = require("ffmpeg-static");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180000, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function signalRange(file, crop) {
  const filter = `${crop ? `crop=${crop},` : ""}signalstats,metadata=print:file=-`;
  const result = run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", filter, "-frames:v", "1", "-f", "null", "-"]);
  const text = result.stdout + result.stderr;
  const mins = [...text.matchAll(/YMIN=(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  const maxs = [...text.matchAll(/YMAX=(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  assert.ok(mins.length && maxs.length, `missing signal metadata for ${path.basename(file)}`);
  return Math.max(...maxs) - Math.min(...mins);
}

function similarity(first, second) {
  const result = run(ffmpeg, ["-hide_banner", "-i", first, "-i", second, "-lavfi", "ssim", "-f", "null", "-"]);
  const match = (result.stderr + result.stdout).match(/All:([0-9.]+)/);
  assert.ok(match, "ffmpeg did not report SSIM");
  return Number(match[1]);
}

test("motion primitives render structurally and change perceptually at 16:9", { timeout: 300000 }, () => {
  const remotionDir = path.join(__dirname, "../remotion");
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-regression-"));
  try {
    run(process.execPath, ["scripts/render-motion-regression.mjs", outputDir], { cwd: remotionDir, timeout: 260000 });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    assert.equal(manifest.length, 5);
    for (const frame of manifest) {
      assert.deepEqual([frame.width, frame.height], [1920, 1080], `${frame.id} must use the production aspect ratio`);
      assert.ok(signalRange(path.join(outputDir, frame.filename)) > 45, `${frame.filename} lacks tonal structure`);
    }

    const relationships = path.join(outputDir, "relationships-transform.png");
    const subjects = path.join(outputDir, "subjects-transform.png");
    for (let row = 0; row < 3; row++) for (let column = 0; column < 5; column++) {
      assert.ok(signalRange(relationships, `378:250:${column * 382}:${row * 265}`) > 24, `relationship cell ${row},${column} is visually empty`);
    }
    for (let row = 0; row < 2; row++) for (let column = 0; column < 4; column++) {
      assert.ok(signalRange(subjects, `466:500:${column * 474}:${row * 510}`) > 24, `subject cell ${row},${column} is visually empty`);
    }

    assert.ok(similarity(relationships, path.join(outputDir, "relationships-consequence.png")) < 0.995, "relationship operations do not visibly progress");
    assert.ok(similarity(subjects, path.join(outputDir, "subjects-consequence.png")) < 0.995, "subject operations do not visibly progress");
    assert.ok(signalRange(path.join(outputDir, "bookend.png"), "760:760:1110:90") > 30, "two-character reaction panel lacks visible subjects");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
