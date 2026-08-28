const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
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

// ffmpeg gives aggregate statistics; these two checks need per-pixel colour, so
// the PNG is decoded directly. zlib is built in, so this costs no dependency.
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  assert.ok(width && height, `could not read a PNG header from ${file}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

// Vertically separated blocks of accent-coloured (#FFD166) copy in the model
// half of the frame. Rows closer together than `gapRows` belong to one wrapped
// paragraph; a genuinely duplicated statement lands far below the first.
//
// Only meaningful on a payoff frame. Payoff-state geometry is green, so accent
// pixels there are the closing copy and nothing else -- on a hypothesis frame
// the gold palette (#E8B96A) would make the geometry itself register. The
// `minPeak` floor keeps thin strokes out: rendered copy fills a far larger
// share of its rows than a stroke does, so it survives the floor and stray
// accent marks do not.
function accentCopyBlocks(file, { gapRows = 40, minPeak = 0.05 } = {}) {
  const img = decodePng(file);
  const half = Math.floor(img.width * 0.55);
  const blocks = [];
  let current = null;
  let gap = 0;
  const close = () => {
    if (current && current.bottom - current.top >= 6 && current.peak >= minPeak) blocks.push(current);
    current = null;
  };
  for (let y = 0; y < img.height; y++) {
    let hits = 0;
    for (let x = 0; x < half; x++) {
      const i = y * img.width * img.channels + x * img.channels;
      if (img.data[i] > 200 && img.data[i + 1] > 150 && img.data[i + 2] < 140) hits++;
    }
    const coverage = hits / half;
    if (coverage > 0.004) {
      current = current
        ? { ...current, bottom: y, peak: Math.max(current.peak, coverage) }
        : { top: y, bottom: y, peak: coverage };
      gap = 0;
    } else if (current && ++gap > gapRows) close();
  }
  close();
  return blocks;
}

// Share of pixels above a luma threshold, for measuring entity activation.
function brightRatio(img, left, top, width, height, threshold = 90) {
  let bright = 0, total = 0;
  for (let y = top; y < Math.min(img.height, top + height); y++) {
    for (let x = left; x < Math.min(img.width, left + width); x++) {
      const i = y * img.width * img.channels + x * img.channels;
      if (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] > threshold) bright++;
      total++;
    }
  }
  return bright / Math.max(1, total);
}

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

      // Counter cases must activate their entities, not just print a rising
      // number over a static field. Comparing bright coverage inside the cell
      // between the two phases proves the entities themselves light up.
      const earlyImage = decodePng(early);
      const lateImage = decodePng(late);
      cases.forEach((item, index) => {
        if (item.operation !== "counter") return;
        const left = (index % 4) * 480 + 6;
        const top = Math.floor(index / 4) * 270 + 10;
        const grew = brightRatio(lateImage, left, top, 468, 250) - brightRatio(earlyImage, left, top, 468, 250);
        assert.ok(grew > 0.004, `counter/${item.primitive} does not visibly activate its entities (bright coverage moved ${(grew * 100).toFixed(3)}%)`);
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
    assert.match(source, /showTitle \? <Title>/, "only the opening bookend may own the ordinary title");
    assert.match(source, /!isPayoff && characterDominant && keyText/, "payoff must suppress the ordinary key-text panel");
    // ...and prove it in the frame, not only in the source. If the payoff
    // overlay and the ordinary key-text panel ever render together again, the
    // closing statement appears as two separated blocks of accent copy.
    const copyBlocks = accentCopyBlocks(payoff);
    assert.equal(
      copyBlocks.length, 1,
      `the closing statement must appear exactly once, found ${copyBlocks.length} blocks of accent copy at ${copyBlocks.map((b) => `y${b.top}-${b.bottom}`).join(", ")}`,
    );

    // Crowded authored copy must resolve structurally: visible entities remain
    // in the safe area, while the renderer limits text ownership instead of
    // pushing pills beyond the frame or shrinking them into illegibility.
    const dense = decodePng(path.join(outputDir, "dense-labels.png"));
    assert.ok(brightRatio(dense, 120, 210, 1680, 650, 70) > 0.015, "dense model lost its explanatory foreground");
    assert.ok(brightRatio(dense, 0, 150, 45, 780, 70) < 0.006, "dense model leaks into the left safe edge");
    assert.ok(brightRatio(dense, 1875, 150, 45, 780, 70) < 0.006, "dense model leaks into the right safe edge");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
