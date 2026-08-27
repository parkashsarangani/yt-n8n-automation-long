const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const ffmpeg = require("ffmpeg-static");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 240000, ...options });
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

function similarity(first, second, crop) {
  const filter = crop
    ? `[0:v]crop=${crop}[a];[1:v]crop=${crop}[b];[a][b]ssim`
    : "ssim";
  const result = run(ffmpeg, ["-hide_banner", "-i", first, "-i", second, "-lavfi", filter, "-f", "null", "-"]);
  const match = (result.stderr + result.stdout).match(/All:([0-9.]+)/);
  assert.ok(match, "ffmpeg did not report SSIM");
  return Number(match[1]);
}

const cellCrop = (index) => `468:250:${(index % 4) * 480 + 6}:${Math.floor(index / 4) * 270 + 10}`;

test("every production-valid motion case has isolated foreground pixels and visible progression", { timeout: 360000 }, () => {
  const remotionDir = path.join(__dirname, "../remotion");
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-regression-"));
  try {
    run(process.execPath, ["scripts/render-motion-regression.mjs", outputDir], { cwd: remotionDir, timeout: 320000 });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    assert.equal(manifest.compatibilityCases.length, 64);
    assert.equal(new Set(manifest.compatibilityCases.map((item) => `${item.operation}/${item.primitive}`)).size, 64);
    for (const frame of manifest.frames) {
      assert.deepEqual([frame.width, frame.height], [1920, 1080], `${frame.id} must use the production aspect ratio`);
    }

    const pages = [...new Set(manifest.frames.filter((item) => item.kind === "compatibility").map((item) => item.page))];
    for (const page of pages) {
      const early = path.join(outputDir, `compatibility-${page}-42.png`);
      const late = path.join(outputDir, `compatibility-${page}-96.png`);
      const cases = manifest.frames.find((item) => item.kind === "compatibility" && item.page === page).cases;
      cases.forEach((item, index) => {
        const crop = cellCrop(index);
        assert.ok(signalRange(late, crop) > 8, `${item.operation}/${item.primitive} has no isolated foreground`);
        assert.ok(similarity(early, late, crop) < 0.9995, `${item.operation}/${item.primitive} does not visibly progress`);
      });
    }

    const statePages = [...new Set(manifest.frames.filter((item) => item.kind === "state").map((item) => item.page))];
    for (const page of statePages) {
      const hypothesis = path.join(outputDir, `state-${page}-hypothesis.png`);
      const contradiction = path.join(outputDir, `state-${page}-contradiction.png`);
      const primitives = manifest.frames.find((item) => item.kind === "state" && item.page === page).primitives;
      primitives.forEach((primitive, index) => {
        assert.ok(similarity(hypothesis, contradiction, cellCrop(index)) < 0.9995, `${primitive} does not visibly transition from hypothesis to contradiction`);
      });
    }

    const bookend = path.join(outputDir, "bookend.png");
    const emptyBookend = path.join(outputDir, "bookend-empty.png");
    assert.ok(similarity(bookend, emptyBookend, "760:760:1110:90") < 0.985, "bookend panel does not contain detectable character pixels");

    const backgrounds = ["network", "path", "quantity"].map((primitive) => path.join(outputDir, `background-${primitive}.png`));
    assert.ok(similarity(backgrounds[0], backgrounds[1]) < 0.995, "relational and spatial background fields are indistinguishable");
    assert.ok(similarity(backgrounds[1], backgrounds[2]) < 0.995, "spatial and quantitative background fields are indistinguishable");

    const payoff = path.join(outputDir, "payoff.png");
    assert.ok(signalRange(payoff) > 45, "payoff frame lacks a decisive visual resolution");
    const source = fs.readFileSync(path.join(remotionDir, "src/compositions/ExplanationScene.tsx"), "utf8");
    assert.equal((source.match(/data-payoff-copy="single"/g) || []).length, 1, "payoff copy must have one owner");
    assert.match(source, /!isPayoff \? <Title>/, "payoff must suppress the ordinary title");
    assert.match(source, /!isPayoff && characterDominant && keyText/, "payoff must suppress the ordinary key-text panel");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
