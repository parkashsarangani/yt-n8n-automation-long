/**
 * compose.js
 * -----------------------------------------------------------------------
 * Express endpoint: POST /compose
 * Studio-grade long-form video compositor (YouTube long-form)
 * Hybrid architecture: Remotion for templates/captions + ffmpeg for
 * stock scenes, audio mixing, transitions, and final encoding.
 * -----------------------------------------------------------------------
 */

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json({ limit: "200mb" }));
// In-memory job store for the async compose pattern
const jobStore = new Map();

const OUTPUT_DIR = process.env.OUTPUT_DIR || "/outputs";
app.use("/outputs", express.static(OUTPUT_DIR));

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, "music");
const MOTION_ASSETS_DIR = process.env.MOTION_ASSETS_DIR || path.join(__dirname, "motion-assets");
const REMOTION_DIR = path.join(__dirname, "remotion");
const TOPIC_HISTORY_PATH = process.env.TOPIC_HISTORY_PATH || path.join(__dirname, "topic_history.json");
const TOPIC_HISTORY_MAX = 90;
const RUN_LOG_PATH = process.env.RUN_LOG_PATH || path.join(path.dirname(TOPIC_HISTORY_PATH), "run_log.jsonl");

const TARGET_W = 1920;
const TARGET_H = 1080;
const FPS = 30;

// Long-form scaling knobs:
// - COMPOSE_CONCURRENCY bounds how many scenes build in parallel (default 3);
//   40-50 scenes built all-at-once with the Ken-Burns upscale OOMs the 6GB box.
// - KENBURNS_UPSCALE is the pre-zoompan upscale height (default 3500 for long-form,
//   down from 6000) to cut per-process RAM while keeping sub-pixel headroom.
const COMPOSE_CONCURRENCY = Math.max(1, parseInt(process.env.COMPOSE_CONCURRENCY || "3", 10));
const KENBURNS_UPSCALE = Math.max(2200, parseInt(process.env.KENBURNS_UPSCALE || "3500", 10));

// Detect video encoder hardware support (libx264 fallback)
const V_ENCODER = process.env.USE_NVENC ? "h264_nvenc" : "libx264";

// Hybrid AI-video: animate the hook + payoff stills into short clips for real
// motion (the rest stay Ken-Burns stills). Any failure falls back to the
// still, so a bad/blocked clip never kills a video.
//
// OFF BY DEFAULT. The budget LTX model warped stills into irrelevant footage,
// so we ship the (much-improved) Ken-Burns stills instead. To re-enable, set
// FAL_VIDEO_ENABLED=true AND provide FAL_KEY - and ideally step FAL_VIDEO_MODEL
// up to a higher-fidelity model (e.g. fal-ai/wan/v2.2-a14b/image-to-video)
// since LTX's coherence is the reason it was turned off.
const FAL_KEY = process.env.FAL_KEY || "";
const FAL_VIDEO_ENABLED = /^(1|true|yes)$/i.test(process.env.FAL_VIDEO_ENABLED || "");
const FAL_VIDEO_MODEL = process.env.FAL_VIDEO_MODEL || "fal-ai/ltx-video/image-to-video";
const FAL_VIDEO_PROMPT =
  "Subtle cinematic camera motion - a slow push-in with gentle parallax. Keep the subject, composition and scene EXACTLY as in the source image; only add natural camera movement and soft ambient motion. Photorealistic and stable. No warping, no morphing, no new or changing objects, no distortion of faces or text.";

// Fixed engagement outro appended to every video. 2.5s gives the four
// asks (comment, like, share, follow) room to land - the KineticText
// template reveals words one at a time, so a bare 2s felt rushed.
const OUTRO_DURATION_SEC = 2.5;
const DEFAULT_OUTRO_LINE = "Comment, like, share, and follow";

// ---------------------------------------------------------------------------
// Endpoints: Topic History
// ---------------------------------------------------------------------------

// Per-niche history files so Geography and Historical Mysteries dedup
// independently. ?niche=<niche> selects the file; unknown/blank -> "default".
function historyPathFor(niche) {
  const safe = String(niche || "default").replace(/[^a-z0-9_-]/gi, "") || "default";
  return path.join(path.dirname(TOPIC_HISTORY_PATH), `topic_history_${safe}.json`);
}

app.get("/topic-history", async (req, res) => {
  try {
    const p = historyPathFor(req.query.niche);
    if (!fs.existsSync(p)) return res.json({ topics: [] });
    const raw = await fsp.readFile(p, "utf8");
    return res.json({ topics: JSON.parse(raw) });
  } catch (err) {
    console.error("Failed to read topic history:", err);
    return res.status(500).json({ topics: [], error: err.message });
  }
});

app.post("/topic-history", async (req, res) => {
  try {
    const { topic, hook } = req.body;
    if (!topic) return res.status(400).json({ success: false, error: "topic is required" });

    const p = historyPathFor(req.query.niche);
    let topics = [];
    if (fs.existsSync(p)) {
      topics = JSON.parse(await fsp.readFile(p, "utf8"));
    }
    topics.push({ topic, hook: hook || null, created_at: new Date().toISOString() });
    if (topics.length > TOPIC_HISTORY_MAX) {
      topics = topics.slice(topics.length - TOPIC_HISTORY_MAX);
    }
    // The data dir (/app/data) is a mounted named volume; ensure it exists so
    // the write works regardless of how the app is run.
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(topics, null, 2));
    return res.json({ success: true, count: topics.length });
  } catch (err) {
    console.error("Failed to write topic history:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newTmpDir() {
  const dir = path.join(os.tmpdir(), "long-" + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadFile(url, destPath) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  await fsp.writeFile(destPath, res.data);
  return destPath;
}

async function writeBase64(base64, destPath) {
  await fsp.writeFile(destPath, Buffer.from(base64, "base64"));
  return destPath;
}

function generateSilentAudioBase64(durationSec) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `silence-${crypto.randomUUID()}.mp3`);
    execFile(
      ffmpegPath,
      ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(durationSec), "-c:a", "libmp3lame", "-b:a", "64k", tmpPath],
      (err) => {
        if (err) return reject(err);
        fs.readFile(tmpPath, (readErr, data) => {
          fs.unlink(tmpPath, () => { });
          if (readErr) return reject(readErr);
          resolve(data.toString("base64"));
        });
      }
    );
  });
}

function run(cmdBuilder) {
  return new Promise((resolve, reject) => {
    cmdBuilder
      .on("start", (cmd) => console.log("[ffmpeg]", cmd))
      .on("error", (err, stdout, stderr) => {
        console.error("[ffmpeg error]", err.message);
        console.error(stderr);
        reject(err);
      })
      .on("end", () => resolve())
      .run();
  });
}

// loudnorm computes a gain from the input's measured LUFS to the -16 LUFS
// target - on true digital silence (e.g. the outro's generated silent
// track) or other near-silent audio, measured loudness is -infinity, and
// the resulting gain is NaN, which crashes the AAC encoder entirely. Try
// with loudnorm first (normal case); if it fails, retry the identical
// encode without it rather than losing the whole scene.
async function runAudioMux(cmdFactory) {
  try {
    await run(cmdFactory(true));
  } catch (err) {
    console.warn(`[loudnorm] normalization failed (${err.message}), retrying without it`);
    await run(cmdFactory(false));
  }
}

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration);
    });
  });
}

// Bounded-concurrency map that never throws mid-flight: returns Promise.allSettled
// -shaped results ({status,value|reason}) in input order, running at most `limit`
// tasks at once. Long-form has 40-50 scenes; building them all in parallel (the
// old allSettled) OOMs the 6GB box, so we cap the pool.
async function mapSettledWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }
  const n = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// House-style gradient still for a degraded scene (Fal generation failed upstream).
// Keeps the video complete + audio-synced instead of failing the whole run.
function pickGradientBackground() {
  const dir = path.join(MOTION_ASSETS_DIR, "backgrounds");
  for (const c of ["gradient_charcoal.png", "card_left.png", "card_right.png"]) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
    if (files.length) return path.join(dir, files[0]);
  } catch (e) { /* fall through */ }
  throw new Error("no gradient background asset available for placeholder");
}

// Render a 1280x720 thumbnail PNG: background image (or gradient), a darkened
// bottom band for legibility, and the punchy thumbnail text in Inter-Black with
// the niche accent color. Identical template across niches (only image + accent
// differ) so the A/B comparison isn't confounded by thumbnail construction.
// ---------------------------------------------------------------------------
// drawtext-capable ffmpeg
//
// The bundled ffmpeg-static binary is FFmpeg 7.x built WITHOUT libharfbuzz.
// Since 7.0 harfbuzz is a hard requirement for the drawtext filter, so that
// build silently has no drawtext at all — every thumbnail attempt died with
// "No such filter: 'drawtext'", and the /compose path swallowed it in a
// try/catch and carried on. The result was months of videos published with
// YouTube's auto-selected frame instead of a designed thumbnail, with nothing
// louder than a warning to say so.
//
// The image also installs Debian's ffmpeg (5.1.x), which does have drawtext.
// Probe for a binary that actually supports it rather than assuming, and leave
// the video pipeline on ffmpeg-static — that part works and is not worth
// disturbing.
// ---------------------------------------------------------------------------
const execFileAsync = require("util").promisify(require("child_process").execFile);
let _textFfmpeg;
function hasDrawtext(bin) {
  try {
    const out = require("child_process").execFileSync(bin, ["-hide_banner", "-filters"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return /^\s*\S+\s+drawtext\s/m.test(out);
  } catch { return false; }
}
function textFfmpegPath() {
  if (_textFfmpeg !== undefined) return _textFfmpeg;
  const candidates = [process.env.FFMPEG_TEXT_PATH, "/usr/bin/ffmpeg", "ffmpeg", ffmpegPath]
    .filter(Boolean);
  _textFfmpeg = candidates.find(hasDrawtext) || null;
  if (_textFfmpeg) {
    console.log(`[thumbnail] drawtext-capable ffmpeg: ${_textFfmpeg}`);
  } else {
    console.error(
      "[thumbnail] NO ffmpeg with drawtext found — thumbnails cannot have text burned in. " +
      "Install an ffmpeg built with libharfbuzz/libfreetype, or set FFMPEG_TEXT_PATH.",
    );
  }
  return _textFfmpeg;
}

// Records which background was actually used, so callers can report a gradient
// fallback rather than claiming the supplied image was applied. Read via
// lastThumbnailBackground() immediately after the call.
let _lastThumbnailBackground = "gradient";
function lastThumbnailBackground() { return _lastThumbnailBackground; }

async function buildThumbnail(imageUrl, text, accent, tmpDir, outPath, imageBase64) {
  let bgPath;
  _lastThumbnailBackground = "gradient";
  if (imageBase64) {
    bgPath = path.join(tmpDir, `thumb_bg_${crypto.randomUUID()}.png`);
    await writeBase64(imageBase64, bgPath);
    _lastThumbnailBackground = "supplied";
  } else if (imageUrl) {
    bgPath = path.join(tmpDir, `thumb_bg_${crypto.randomUUID()}.png`);
    try {
      await downloadFile(imageUrl, bgPath);
      _lastThumbnailBackground = "supplied";
    } catch (e) { bgPath = pickGradientBackground(); }
  } else {
    bgPath = pickGradientBackground();
  }
  const fontPath = path.join(MOTION_ASSETS_DIR, "fonts", "Inter-Black.ttf");
  const safeFont = fontPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const txt = String(text || "").replace(/[\\':]/g, " ").replace(/[{}]/g, "").trim().slice(0, 48);
  const accentHex = "0x" + String(accent || "#FFFFFF").replace(/^#/, "");
  const vf = [
    "scale=1280:720:force_original_aspect_ratio=increase",
    "crop=1280:720",
    "eq=contrast=1.08:saturation=1.15",
    "drawbox=x=0:y=468:w=1280:h=252:color=black@0.55:t=fill",
    `drawtext=fontfile='${safeFont}':text='${txt}':fontcolor=${accentHex}:fontsize=76:borderw=5:bordercolor=black:x=(w-text_w)/2:y=545`,
  ].join(",");
  const textBin = textFfmpegPath();
  if (!textBin) {
    throw new Error(
      "no ffmpeg with the drawtext filter is available; cannot render thumbnail text",
    );
  }

  // Spawned directly rather than through fluent-ffmpeg.
  //
  // fluent-ffmpeg re-splits option values on whitespace, and the -vf value
  // contains the thumbnail text. The damage was word-count dependent — one
  // word worked, two words produced a corrupt filtergraph, three worked again —
  // which is why this looked like a mysterious per-text failure. execFile takes
  // argv verbatim, so spaces in the overlay text are simply not special.
  await execFileAsync(textBin, [
    "-y",
    "-i", bgPath,
    "-vf", vf,
    "-frames:v", "1",
    outPath,
  ], { timeout: 60000 });
  return outPath;
}

// ---------------------------------------------------------------------------
// Studio Color Grading (split-tone with shadow lift and highlight rolloff)
// ---------------------------------------------------------------------------

function getColorGrade(mood) {
  // Bright, punchy, realistic - NOT the old hazy "film" look. The previous
  // curves lifted blacks to ~0.06 (milky/foggy shadows) and capped whites at
  // ~0.94 (never fully bright), which read as dull and washed out. These use a
  // contrast S-curve with near-true blacks (tiny 0.01 lift to avoid crushing)
  // and full whites for a crisp, vivid, scroll-stopping image.
  const punchCurve = (b, s, m, h) => `curves=m='0/${b} 0.25/${s} 0.5/${m} 0.75/${h} 1/1.0'`;
  const grades = {
    upbeat: [
      "eq=contrast=1.18:saturation=1.42:brightness=0.03",
      "colorbalance=rs=0.10:gs=0.03:bs=-0.06:rh=0.05:gh=0.02:bh=-0.03",
      punchCurve("0.01", "0.20", "0.53", "0.86"),
    ].join(","),
    serious: [
      "eq=contrast=1.20:saturation=1.05:brightness=0.01",
      "colorbalance=rs=-0.03:gs=0.0:bs=0.05:rh=0.02:gh=-0.01:bh=0.03",
      punchCurve("0.01", "0.19", "0.51", "0.84"),
    ].join(","),
    funny: [
      "eq=contrast=1.16:saturation=1.55:brightness=0.04",
      "colorbalance=rs=0.09:gs=0.06:bs=-0.05:rh=0.04:gh=0.05:bh=-0.02",
      punchCurve("0.02", "0.21", "0.54", "0.87"),
    ].join(","),
    neutral: [
      "eq=contrast=1.16:saturation=1.28:brightness=0.03",
      "colorbalance=rs=0.02:gs=0.0:bs=0.01:rh=0.03:gh=0.01:bh=-0.01",
      punchCurve("0.01", "0.20", "0.52", "0.85"),
    ].join(","),
  };
  return grades[mood] || grades.neutral;
}

function pickMusicTrack(mood) {
  const candidate = path.join(MUSIC_DIR, `${(mood || "neutral").toLowerCase()}.mp3`);
  if (fs.existsSync(candidate)) return candidate;
  return path.join(MUSIC_DIR, "neutral.mp3");
}

// ---------------------------------------------------------------------------
// Remotion Render Bridge
// ---------------------------------------------------------------------------

function renderRemotion(compositionId, outputPath, durationSec, props) {
  return new Promise(async (resolve, reject) => {
    const bridgePath = path.join(REMOTION_DIR, "render-bridge.mjs");

    // Write props to a temp file to avoid E2BIG when props contain large
    // base64 images. The render-bridge reads from file when a path is passed.
    const propsFile = path.join(path.dirname(outputPath), `props_${Date.now()}.json`);
    await fsp.writeFile(propsFile, JSON.stringify(props));

    const args = [
      bridgePath,
      compositionId,
      outputPath,
      String(durationSec),
      `@${propsFile}`, // "@" prefix tells render-bridge to read from file
    ];

    console.log(`[remotion] Rendering ${compositionId} (${durationSec}s)...`);
    execFile("node", args, {
      cwd: REMOTION_DIR,
      timeout: 300000, // 5 min max
      maxBuffer: 10 * 1024 * 1024,
    }, async (err, stdout, stderr) => {
      if (stdout) console.log("[remotion stdout]", stdout);
      if (stderr) console.log("[remotion stderr]", stderr);
      // Clean up props file
      fsp.unlink(propsFile).catch(() => { });
      if (err) {
        console.error("[remotion] Render failed:", err.message);
        return reject(err);
      }
      resolve(outputPath);
    });
  });
}

// ---------------------------------------------------------------------------
// AI Image -> Video (fal image-to-video, e.g. LTX) for hook/payoff motion
// ---------------------------------------------------------------------------

// Animate a still (the fal image URL) into a short clip. Uses the synchronous
// fal.run endpoint; returns the downloaded clip path. Callers wrap this in a
// try/catch and fall back to the Ken-Burns still on any failure.
async function generateVideoFromImage(imageUrl, outPath) {
  const res = await axios.post(
    `https://fal.run/${FAL_VIDEO_MODEL}`,
    { image_url: imageUrl, prompt: FAL_VIDEO_PROMPT },
    {
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      timeout: 180000,
    }
  );
  const url = res.data?.video?.url || res.data?.videos?.[0]?.url;
  if (!url) throw new Error("fal video model returned no video url: " + JSON.stringify(res.data).slice(0, 300));
  await downloadFile(url, outPath);
  return outPath;
}

// ---------------------------------------------------------------------------
// Stock Scene Processing (ffmpeg — eased zoompan, cinematic grading)
// ---------------------------------------------------------------------------

async function buildStockVideoScene(stockVideoPath, audioPath, duration, outPath, sceneIdx, mood) {
  const stockDuration = await ffprobeDuration(stockVideoPath);

  // The AI clip (~5s) is usually SHORTER than the scene's narration. The old
  // behaviour froze the last frame (tpad clone) to fill the gap, so the motion
  // visibly STOPPED partway through the scene. Instead, slow the clip with
  // setpts so its movement spans the entire scene - continuous motion, never a
  // freeze. (+0.15s of headroom so the final -t trims cleanly at the end.)
  const stretch =
    stockDuration > 0.1 && stockDuration < duration
      ? (duration + 0.15) / stockDuration
      : 1;
  const stretchFilter = stretch > 1.01 ? `setpts=${stretch.toFixed(4)}*PTS,` : "";

  // Cinematic processing: scale to fill, crop, split-tone grade, and a
  // subtle unsharp for crispness (vignette removed - it read too heavy).
  const gradeFilter = getColorGrade(mood);

  const videoFilter = [
    `[0:v]${stretchFilter}scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase`,
    `crop=${TARGET_W}:${TARGET_H}`,
    gradeFilter,
    `unsharp=5:5:0.4:5:5:0.0`,
  ].join(",") + "[processed]";

  await runAudioMux((normalize) => {
    const opts = ["-map", "[processed]", "-map", "1:a", "-t", String(duration)];
    if (normalize) opts.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
    opts.push(
      "-c:v", V_ENCODER,
      "-r", String(FPS),
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
    );
    return ffmpeg()
      .input(stockVideoPath)
      .input(audioPath)
      .complexFilter([videoFilter])
      .outputOptions(opts)
      .output(outPath);
  });

  return outPath;
}

async function buildImageScene(imagePaths, audioPath, duration, outPath, sceneIdx, mood, isEmphasis = false) {
  // Eased Ken Burns with sinusoidal motion (not linear)
  // Creates organic, handheld-feeling camera movement
  const fps = FPS;
  // ONE continuous Ken Burns move per distinct image - not one per time slice.
  // The old code split every scene into 3.5-4.5s segments and, with a single
  // image, re-ran the zoom FROM THE START in each segment, so one photo looked
  // like it zoomed over and over. Now a scene with 1 image is one smooth move
  // across the whole scene; a scene with 2 images cuts once between them.
  // Emphasis (payoff) scene is always a single deliberate push-in.
  const numSegments = isEmphasis ? 1 : Math.max(1, imagePaths.length);
  const segDuration = duration / numSegments;
  const totalFrames = Math.ceil(segDuration * fps);
  const gradeFilter = getColorGrade(mood);

  const segmentPaths = [];
  for (let seg = 0; seg < numSegments; seg++) {
    const imgPath = imagePaths[seg % imagePaths.length];
    const segOutPath = path.join(path.dirname(outPath), `seg_${sceneIdx}_${seg}.mp4`);
    const panLeftToRight = seg % 2 === 0;

    // Sinusoidal easing: slow start, slow end, gentle drift through the middle
    // zoompan expressions use on/d for normalized progress
    const xExpr = panLeftToRight
      ? `'iw*0.035*(1-cos(PI*on/${totalFrames}))/2'`
      : `'iw*0.035*(1+cos(PI*on/${totalFrames}))/2'`;

    // Alternate the camera move per SCENE for variety: even scenes slowly
    // push IN, odd scenes pull OUT (gently eased). Breaks the "same subtle
    // drift on every scene" monotony without speeding anything up, and keeps
    // the motion coherent within a scene (all its segments move the same way).
    const pushIn = sceneIdx % 2 === 0;
    const zoomExpr = pushIn
      ? `'1.05+0.05*(1-cos(PI*on/${totalFrames}))/2'`
      : `'1.10-0.05*(1-cos(PI*on/${totalFrames}))/2'`;

    // Gentle punch-in on the first segment only, eased over its own window
    const punchFrames = Math.min(18, Math.round(totalFrames * 0.3));
    const finalZoom = isEmphasis
      ? `'1.02+0.18*(1-cos(PI*on/${totalFrames}))/2'`
      : sceneIdx === 0 && seg === 0
        ? `'if(lte(on,${punchFrames}),1.13-0.04*on/${punchFrames},${zoomExpr.slice(1, -1)})'`
        : zoomExpr;

    const filterGraph = [
      // Upscale well past the output resolution before zoompan - cropping
      // from a source close to the output size makes the per-frame crop
      // window round to whole pixels unevenly, which reads as flicker/
      // vibration. The extra sub-pixel headroom eliminates that jitter.
      `[0:v]scale=-2:${KENBURNS_UPSCALE},zoompan=z=${finalZoom}:x=${xExpr}:y='ih*0.02*(1-cos(PI*on/${totalFrames}))/2':d=${totalFrames}:s=${TARGET_W}x${TARGET_H}:fps=${fps}[zoomed]`,
      `[zoomed]${gradeFilter}[graded]`,
      `[graded]unsharp=5:5:0.4:5:5:0.0[final]`,
    ];

    await run(
      ffmpeg()
        .input(imgPath)
        .complexFilter(filterGraph)
        .outputOptions([
          "-map", "[final]",
          "-t", String(segDuration),
          "-c:v", V_ENCODER,
          "-r", String(fps),
          "-preset", "veryfast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-an",
        ])
        .output(segOutPath)
    );
    segmentPaths.push(segOutPath);
  }

  // Concatenate segments
  const sceneVideoPath = path.join(path.dirname(outPath), `scenevid_${sceneIdx}.mp4`);
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], sceneVideoPath);
  } else {
    const listPath = path.join(path.dirname(outPath), `seglist_${sceneIdx}.txt`);
    const listContent = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await fsp.writeFile(listPath, listContent);
    await run(
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions(["-c", "copy"])
        .output(sceneVideoPath)
    );
  }

  // Mux with audio
  await runAudioMux((normalize) => {
    const opts = ["-map", "0:v", "-map", "1:a", "-t", String(duration)];
    if (normalize) opts.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
    opts.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k");
    return ffmpeg()
      .input(sceneVideoPath)
      .input(audioPath)
      .outputOptions(opts)
      .output(outPath);
  });

  return outPath;
}

// ---------------------------------------------------------------------------
// Template Scene Processing (Remotion — studio motion graphics)
// ---------------------------------------------------------------------------

async function buildTemplateScene(templateName, templateData, duration, audioPath, outPath, tmpDir, mood, bgImagePath = null) {
  // --- Direct name → composition ID map (existing templates) ---
  const directMap = {
    stat_reveal: "StatReveal",
    comparison: "Comparison",
    kinetic_text: "KineticText",
  };

  // --- Category pools: the AI specifies a category, we pick randomly ---
  const categoryPools = {
    list: [
      "ListAsymmetric3", "ListNumberedVertical", "ListStaggered",
      "ListFullscreenSequence", "ListMinimalLeft", "ListStatsFocused",
      "ListTimeline", "ListUnevenGrid", "ListTwoColumnCompare",
      "ListSimpleText", "ListHorizontalPeek", "ListHeroWithList",
    ],
    data: [
      "DataBarChart", "DataLineChart", "DataPieChart", "DataStatsCards",
      "DataProgressBars", "DataTimeline", "DataRanking", "DataGauge",
    ],
    text: [
      "TextKinetic", "TextScramble", "TextWave", "TextSplit",
      "TextMaskReveal", "TextGlitch", "TextNeon", "Text3DFlip",
      "TextTypewriter", "TextCounter", "TextGradient", "TextExplode",
    ],
    roller: [
      "RollerSlotMachine", "RollerFlip", "RollerFadeSlide", "RollerBlur",
      "RollerScaleBounce", "RollerGlitch", "RollerWave", "RollerTypewriter",
      "RollerLiquid", "RollerVerticalList", "RollerDrum", "RollerMaskSlide",
      "RollerSlotReveal", "RollerDramaticStop", "RollerMultiSlot",
      "RollerCountdown", "RollerOutlineHighlight", "RollerPerspectiveStripes",
      "RollerShuffle", "Roller3DCarousel", "RollerSplitFlap", "RollerGradientWave",
    ],
    cinematic: [
      "CinematicEpic", "CinematicHorror", "CinematicRomance", "CinematicAction",
      "CinematicDocumentary", "CinematicSciFi", "CinematicNoir", "CinematicAnime",
      "CinematicVintage", "CinematicMinimalEnd",
    ],
    // Sub-category shortcuts for AI convenience
    timeline: ["ListTimeline", "DataTimeline"],
    ranking: ["DataRanking", "ListStatsFocused"],
    chart: ["DataBarChart", "DataLineChart", "DataPieChart", "DataGauge"],
    counter: ["TextCounter", "RollerCountdown", "RollerSplitFlap", "RollerDramaticStop"],
    reveal: ["TextMaskReveal", "TextKinetic", "TextGradient", "ListStaggered"],
  };

  // Resolve composition ID: direct map first, then category pool, then treat as literal ID
  let compositionId;
  if (directMap[templateName]) {
    compositionId = directMap[templateName];
  } else if (categoryPools[templateName]) {
    const pool = categoryPools[templateName];
    compositionId = pool[Math.floor(Math.random() * pool.length)];
    console.log(`[template] category "${templateName}" → picked "${compositionId}"`);
  } else {
    // Assume it's a direct composition ID (e.g. "DataBarChart")
    compositionId = templateName;
  }

  // Build props — pass all template_data through as props + mood + background
  // Parse template_data if it's still a string (shouldn't be, but defensive)
  const parsedData = typeof templateData === "string" ? JSON.parse(templateData) : (templateData || {});
  let props = { mood: mood || "neutral", ...parsedData };

  // Normalize props: the AI outputs generic structures (items, events, title)
  // but each template expects specific prop names. Map common patterns.
  if (parsedData.text && !props.line) props.line = parsedData.text;
  if (parsedData.title && !props.heroLines) props.heroLines = [parsedData.title];
  if (parsedData.from !== undefined && !props.words) {
    // Counter templates: pass as words for roller, or text for TextCounter
    props.text = props.text || `${parsedData.from} → ${parsedData.to}${parsedData.unit || ""}`;
  }

  console.log(`[template] ${compositionId} props keys: ${Object.keys(props).join(", ")}`);
  // Pass the background image as a data URI so Remotion can render it behind the template
  if (bgImagePath) {
    try {
      const imgBuf = await fsp.readFile(bgImagePath);
      props.backgroundImage = `data:image/png;base64,${imgBuf.toString("base64")}`;
    } catch (e) {
      console.warn(`[template] failed to read background image: ${e.message}`);
    }
  }

  // Legacy prop mapping for existing templates
  if (compositionId === "StatReveal") {
    props.statValue = templateData?.statValue || props.statValue || "";
    props.label = templateData?.label || props.label || "";
    props.icon = templateData?.icon || "activity";
  } else if (compositionId === "Comparison") {
    props.leftLabel = templateData?.leftLabel || "";
    props.leftValue = templateData?.leftValue || "";
    props.rightLabel = templateData?.rightLabel || "";
    props.rightValue = templateData?.rightValue || "";
  } else if (compositionId === "KineticText") {
    props.line = templateData?.line || props.line || "";
  }

  // Render template via Remotion (full-screen, no image composite).
  // Templates look best on their own dark backgrounds. Overlaying on images
  // makes text harder to read and panels invisible. The visual planner should
  // use templates for data-heavy scenes and images for atmospheric scenes —
  // mixing them in a single frame adds complexity without visual benefit.
  const templateVideoPath = path.join(tmpDir, `remotion_${compositionId}_${Date.now()}.mp4`);
  await renderRemotion(compositionId, templateVideoPath, duration, props);

  // Mux template video (or composite) with audio
  const templateDuration = await ffprobeDuration(templateVideoPath);
  const videoFilter = templateDuration < duration
    ? `[0:v]tpad=stop_mode=clone:stop_duration=${(duration - templateDuration + 0.1).toFixed(3)}[padded]`
    : `[0:v]null[padded]`;

  await runAudioMux((normalize) => {
    const opts = ["-map", "[padded]", "-map", "1:a", "-t", String(duration)];
    if (normalize) opts.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
    opts.push(
      "-c:v", V_ENCODER,
      "-r", String(FPS),
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
    );
    return ffmpeg()
      .input(templateVideoPath)
      .input(audioPath)
      .complexFilter([videoFilter])
      .outputOptions(opts)
      .output(outPath);
  });

  return outPath;
}

// ---------------------------------------------------------------------------
// Karaoke ASS Caption Builder (burn-in via ffmpeg — no transparency issues)
// ---------------------------------------------------------------------------

function toAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}`;
}

function buildAssFromAlignment(scenes, offsets, commentHook, totalDuration) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${TARGET_W}
PlayResY: ${TARGET_H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Inter Bold,62,&H00FFFFFF,&H0000DFFF,&H40000000,&H80000000,0,0,0,0,100,100,0,0,1,3,4,2,60,60,420,1
Style: CommentHook,Inter Bold,54,&H00FFFFFF,&H000000FF,&H40202020,&HC0000000,0,0,0,0,100,100,0,0,3,0,4,2,80,80,680,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = "";
  // Show phrases of ~6-10 words at a time, with the spoken word highlighted.
  const WORDS_PER_PHRASE = 8;

  scenes.forEach((scene, sceneIdx) => {
    if (scene?.template_data?.is_outro) return;
    const alignment = scene?.audio?.alignment;
    if (!alignment) return;

    const chars = alignment.characters;
    const starts = alignment.character_start_times_seconds;
    const ends = alignment.character_end_times_seconds;

    const words = [];
    let current = "";
    let wordStart = null;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === " " || ch === "\n") {
        if (current) {
          words.push({ text: current, start: wordStart, end: ends[i - 1] });
          current = "";
          wordStart = null;
        }
        continue;
      }
      if (wordStart === null) wordStart = starts[i];
      current += ch;
    }
    if (current) words.push({ text: current, start: wordStart, end: ends[ends.length - 1] });

    // Group words into phrases
    for (let phraseStart = 0; phraseStart < words.length; phraseStart += WORDS_PER_PHRASE) {
      const phrase = words.slice(phraseStart, phraseStart + WORDS_PER_PHRASE);
      if (!phrase.length || phrase[0].start == null) continue;

      const phraseBegin = phrase[0].start + offsets[sceneIdx];
      const phraseEnd = phrase[phrase.length - 1].end + offsets[sceneIdx];

      // One dialogue line per phrase. All words visible for the entire duration.
      // Use ASS \kf (smooth karaoke fill) to progressively highlight each word
      // in the CaptionHL color as it's spoken.
      let line = "";
      for (let w = 0; w < phrase.length; w++) {
        const word = phrase[w];
        // \kf duration is in centiseconds (100ths of a second)
        const wordDurationCs = Math.round((word.end - word.start) * 100);
        line += `{\\kf${wordDurationCs}}${word.text} `;
      }

      events += `Dialogue: 0,${toAssTime(phraseBegin)},${toAssTime(phraseEnd)},Caption,,0,0,0,,${line.trim()}\n`;
    }
  });

  if (commentHook && totalDuration) {
    // Surface the comment prompt at ~62% of the content - while retention is
    // still high - instead of the final seconds, when most viewers have
    // already swiped away. Hold it ~5s so it's readable, ending before the
    // kicker so it doesn't collide with the payoff.
    const hookStart = totalDuration * 0.62;
    const hookEnd = Math.min(totalDuration, hookStart + 5);
    const escaped = commentHook.replace(/\\/g, "").replace(/\{/g, "").replace(/\}/g, "");
    events += `Dialogue: 1,${toAssTime(hookStart)},${toAssTime(hookEnd)},CommentHook,,0,0,0,,{\\fscx0\\fscy0\\t(0,200,\\fscx120\\fscy120)\\t(200,300,\\fscx100\\fscy100)}${escaped}\n`;
  }

  return header + events;
}

// ---------------------------------------------------------------------------
// Caption Overlay via Remotion (kept for future use with VP9/RGBA output)
// ---------------------------------------------------------------------------

function extractWordsFromAlignment(scenes, offsets) {
  const allWords = [];

  scenes.forEach((scene, sceneIdx) => {
    const alignment = scene?.audio?.alignment;
    if (!alignment) return;

    const chars = alignment.characters;
    const starts = alignment.character_start_times_seconds;
    const ends = alignment.character_end_times_seconds;

    let current = "";
    let wordStart = null;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === " " || ch === "\n") {
        if (current) {
          allWords.push({
            text: current,
            start: wordStart + offsets[sceneIdx],
            end: ends[i - 1] + offsets[sceneIdx],
          });
          current = "";
          wordStart = null;
        }
        continue;
      }
      if (wordStart === null) wordStart = starts[i];
      current += ch;
    }
    if (current && wordStart !== null) {
      allWords.push({
        text: current,
        start: wordStart + offsets[sceneIdx],
        end: ends[ends.length - 1] + offsets[sceneIdx],
      });
    }
  });

  return allWords;
}

async function renderCaptionOverlay(scenes, offsets, commentHook, totalDuration, outPath) {
  const words = extractWordsFromAlignment(scenes, offsets);
  const props = { words, commentHook: commentHook || "", totalDuration };

  await renderRemotion("CaptionOverlay", outPath, totalDuration, props);
  return outPath;
}

// ---------------------------------------------------------------------------
// Scene Concatenation (hard cuts - no crossfade)
// ---------------------------------------------------------------------------

async function concatScenes(scenePaths, outPath) {
  if (scenePaths.length === 1) {
    fs.copyFileSync(scenePaths[0], outPath);
    return outPath;
  }

  const listPath = path.join(path.dirname(outPath), "concat_scenes.txt");
  const listContent = scenePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await fsp.writeFile(listPath, listContent);

  await run(
    ffmpeg()
      .input(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy"])
      .output(outPath)
  );

  return outPath;
}

// Rebuild the voiceover as ONE gapless track. Each scene's audio was AAC-
// encoded separately and then copy-concatenated, which stacks every segment's
// ~23ms encoder-priming silence at the joins - an audible click/hiccup at each
// scene cut. Decoding the raw per-scene voice and re-joining them with the
// concat filter produces a clean, sample-accurate join (no click), and a
// single loudnorm pass over the whole track removes the per-scene level jumps
// the old per-scene loudnorm caused. Total duration is unchanged, so it stays
// in sync with the concatenated video.
async function buildGaplessVoice(audioPaths, outPath) {
  if (audioPaths.length === 1) {
    await runAudioMux((normalize) => {
      const opts = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100"];
      const c = ffmpeg().input(audioPaths[0]);
      if (normalize) c.audioFilters("loudnorm=I=-16:TP=-1.5:LRA=11");
      return c.outputOptions(opts).output(outPath);
    });
    return outPath;
  }
  await runAudioMux((normalize) => {
    const cmd = ffmpeg();
    audioPaths.forEach((p) => cmd.input(p));
    // Normalize each input to a common format before concat (defensive), then
    // join sample-accurately; optionally a single loudnorm over the whole thing.
    const norm = audioPaths.map((_, i) => `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono[a${i}]`).join(";");
    const ins = audioPaths.map((_, i) => `[a${i}]`).join("");
    const tail = normalize
      ? `concat=n=${audioPaths.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[a]`
      : `concat=n=${audioPaths.length}:v=0:a=1[a]`;
    return cmd
      .complexFilter([`${norm};${ins}${tail}`])
      .outputOptions(["-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-ar", "44100"])
      .output(outPath);
  });
  return outPath;
}

// ---------------------------------------------------------------------------
// Main Compose Pipeline
// ---------------------------------------------------------------------------

async function runComposeJob(reqBody, jobId, tmpDir) {
  try {
    const { hook, caption_style, comment_hook, data: scenes } = reqBody;
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("No scenes provided");
    }

    const mood = caption_style || "neutral";

    // Outro card. The pipeline now injects a SPOKEN outro as the final scene -
    // a real narrated share CTA, voiced in the same voice as the narration and
    // flagged template_data.is_outro. When that scene is present we use it as-is
    // (voice + branded KineticText card). Only when it is absent (legacy payload
    // or fallback) do we append the old SILENT branded card, so a render never
    // ends without an outro.
    const hasScriptOutro = scenes.some((s) => s?.template_data?.is_outro);
    if (!hasScriptOutro) {
      const outroAudioBase64 = await generateSilentAudioBase64(OUTRO_DURATION_SEC);
      scenes.push({
        scene_index: scenes.length,
        visual_source: "template",
        template_name: "kinetic_text",
        template_data: { line: reqBody.outro_line || DEFAULT_OUTRO_LINE, is_outro: true },
        audio: { audio_base64: outroAudioBase64 },
      });
    }

    // The payoff/reveal scene = the last content scene before the outro card.
    // It gets a stronger emphasis push-in (video) and a riser+impact accent.
    const emphasisIdx = scenes.length - 2;

    console.log(`[job ${jobId}] Composing ${scenes.length} scenes (mood: ${mood})`);

    // ===== PHASE 1: Build individual scenes with bounded concurrency =====
    // A bounded pool (COMPOSE_CONCURRENCY) rather than all-at-once: 40-50 scenes
    // each running a large zoompan would otherwise OOM the 6GB container. Settled
    // (not throw-fast) so one bad scene doesn't orphan siblings mid-render.
    const startedAt = Date.now();
    const settled = await mapSettledWithConcurrency(scenes, COMPOSE_CONCURRENCY, async (scene, i) => {
      const audioPath = path.join(tmpDir, `voice_${i}.mp3`);
      if (scene?.audio?.audio_base64) {
        await writeBase64(scene.audio.audio_base64, audioPath);
      } else if (scene?.audio?.audio_url) {
        await downloadFile(scene.audio.audio_url, audioPath);
      } else {
        throw new Error(`Scene ${i} missing audio`);
      }

      const duration = await ffprobeDuration(audioPath);
      const outPath = path.join(tmpDir, `scene_${i}_final.mp4`);
      let degraded = false;

      const isTemplate = scene?.visual_source === "template";
      const isStockVideo = !isTemplate && !!scene?.video_url;

      if (isTemplate) {
        if (!scene.template_name) throw new Error(`Scene ${i}: visual_source=template but no template_name`);
        // Templates render full-screen on their own dark background — no image composite.
        await buildTemplateScene(scene.template_name, scene.template_data, duration, audioPath, outPath, tmpDir, mood, null);
      } else if (isStockVideo) {
        const stockVideoPath = path.join(tmpDir, `stock_${i}.mp4`);
        await downloadFile(scene.video_url, stockVideoPath);
        await buildStockVideoScene(stockVideoPath, audioPath, duration, outPath, i, mood);
      } else {
        const imageUrls = scene?.images;
        const imageBase64s = scene?.images_base64;
        let imagePaths;
        if (Array.isArray(imageBase64s) && imageBase64s.length) {
          // VidGen engine sends images as base64 inline rather than URLs.
          imagePaths = await Promise.all(
            imageBase64s.map(async (b64, j) => {
              const p = path.join(tmpDir, `scene_${i}_img_${j}.png`);
              await writeBase64(b64, p);
              return p;
            })
          );
        } else if (Array.isArray(imageUrls) && imageUrls.length) {
          imagePaths = await Promise.all(
            imageUrls.map(async (url, j) => {
              const p = path.join(tmpDir, `scene_${i}_img_${j}.png`);
              return await downloadFile(url, p);
            })
          );
        } else {
          // Degraded scene: Fal generation failed upstream (n8n flags _degraded
          // and sends no images). Use a house-style gradient still so the video
          // stays complete + audio-synced instead of failing the whole run.
          degraded = true;
          imagePaths = [pickGradientBackground()];
          console.warn(`[job ${jobId}] scene ${i} degraded - using gradient placeholder`);
        }

        // Hybrid: animate the hook (first) and payoff scenes into real
        // motion clips; keep the middle as Ken-Burns stills. Any failure
        // (no key, model error, timeout) falls back to the still so a bad
        // clip never breaks the video. Never animate a gradient placeholder.
        const animate = !degraded && FAL_VIDEO_ENABLED && FAL_KEY && (i === 0 || i === emphasisIdx);
        let animated = false;
        if (animate) {
          try {
            const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
            await generateVideoFromImage(imageUrls[0], clipPath);
            await buildStockVideoScene(clipPath, audioPath, duration, outPath, i, mood);
            animated = true;
            console.log(`[ltx] animated scene ${i} (${i === 0 ? "hook" : "payoff"})`);
          } catch (e) {
            console.warn(`[ltx] animation failed for scene ${i} (${e.message}) - using still`);
          }
        }
        if (!animated) {
          await buildImageScene(imagePaths, audioPath, duration, outPath, i, mood, i === emphasisIdx);
        }
      }

      return { path: outPath, duration, degraded };
    }
    );

    const failures = settled
      .map((r, i) => (r.status === "rejected" ? `scene ${i}: ${r.reason?.message || r.reason}` : null))
      .filter(Boolean);
    if (failures.length) {
      throw new Error(`Scene build failed - ${failures.join("; ")}`);
    }

    const sceneResults = settled.map((r) => r.value);
    const scenePaths = sceneResults.map((r) => r.path);
    const durations = sceneResults.map((r) => r.duration);
    const degradedScenes = sceneResults.filter((r) => r.degraded).length;

    // ===== PHASE 2: Concatenate scenes (hard cuts) =====
    const concatPath = path.join(tmpDir, "concat.mp4");
    await concatScenes(scenePaths, concatPath);

    // Calculate actual scene offsets (no overlap - hard cuts)
    const offsets = [0];
    for (let i = 1; i < durations.length; i++) {
      offsets.push(offsets[i - 1] + durations[i - 1]);
    }
    const totalVideoDuration = durations.reduce((a, b) => a + b, 0);

    // ===== PHASE 3: Burn-in captions via ASS (proven approach) =====
    // Remotion caption overlay requires VP9/RGBA to preserve transparency,
    // which adds complexity. ASS captions burned in by ffmpeg are reliable,
    // fast, and visually good enough with proper styling.
    const assPath = path.join(tmpDir, "captions.ass");
    // comment_hook should land in the last moments of the actual content, not
    // over the outro card. The outro is now a variable-length SPOKEN scene, so
    // exclude the actual last-scene duration (not the old fixed 2.5s constant).
    const outroDuration = durations.length > 1 ? durations[durations.length - 1] : 0;
    const contentDuration = totalVideoDuration - outroDuration;
    const assContent = buildAssFromAlignment(scenes, offsets, comment_hook, contentDuration);
    await fsp.writeFile(assPath, assContent);

    // ===== PHASE 4: Sound design + Audio mixing + Final composite =====
    const musicPath = pickMusicTrack(mood);
    const sfxDir = path.join(MOTION_ASSETS_DIR, "sfx");
    const sfxFiles = {
      whoosh: path.join(sfxDir, "whoosh.wav"),
      impact: path.join(sfxDir, "impact.wav"),
      riser: path.join(sfxDir, "riser.wav"),
    };
    const sfxAvailable = {
      whoosh: fs.existsSync(sfxFiles.whoosh),
      impact: fs.existsSync(sfxFiles.impact),
      riser: fs.existsSync(sfxFiles.riser),
    };

    // Sound design: NO per-cut SFX (that whoosh-on-every-cut clashed with the
    // tone). Instead, ONE tasteful accent at the payoff/reveal - a soft riser
    // building into it, then a gentle impact as it lands. This is the single
    // intentional audio beat that punctuates the climax without the noise.
    const sfxEvents = [];
    const emphasisOffset = offsets[emphasisIdx];
    if (emphasisIdx >= 1 && emphasisOffset != null) {
      if (sfxAvailable.riser) sfxEvents.push({ type: "riser", time: Math.max(0, emphasisOffset - 1.3), volume: 0.18 });
      if (sfxAvailable.impact) sfxEvents.push({ type: "impact", time: emphasisOffset, volume: 0.22 });
    }

    // Gapless voiceover: rejoin the per-scene voice cleanly (no boundary
    // clicks) with a single loudnorm (consistent levels), used as the voice
    // track below instead of the concatenated video's gappy audio.
    const voicePath = path.join(tmpDir, "voice_full.m4a");
    await buildGaplessVoice(
      scenes.map((_, i) => path.join(tmpDir, `voice_${i}.mp3`)),
      voicePath
    );

    // ===== PHASE 5: Final composite — video + captions + music + SFX =====
    const finalPath = path.join(tmpDir, "final.mp4");
    const outputFileName = `long_${jobId}.mp4`;
    const outputFullPath = path.join(OUTPUT_DIR, outputFileName);
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });

    const hasMusic = fs.existsSync(musicPath);
    const hasAss = fs.existsSync(assPath);
    const safeAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

    const finalCmd = ffmpeg().input(concatPath);   // [0] = video (+ ignored audio)
    finalCmd.input(voicePath);                     // [1] = gapless voiceover
    if (hasMusic) finalCmd.input(musicPath);
    sfxEvents.forEach((ev) => finalCmd.input(sfxFiles[ev.type]));

    // Track input indices ([0]=video, [1]=voice already taken)
    let nextIdx = 2;
    const musicIdx = hasMusic ? nextIdx++ : null;
    const sfxIndices = sfxEvents.map(() => nextIdx++);

    // Build video filter: ASS caption burn-in + fade in/out
    const fadeOutStart = Math.max(0, totalVideoDuration - 0.5);
    const videoFilter = hasAss
      ? `[0:v]ass=${safeAssPath},fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.5[final_v]`
      : `[0:v]fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.5[final_v]`;

    // Build audio filter: gapless voice ([1:a]) + ducked music
    const audioFilters = [];
    const mixLabels = ["1:a"];

    if (hasMusic) {
      // Gentler ducking: ratio 4 instead of 10, shaped attack/release
      audioFilters.push(`[${musicIdx}:a]aloop=loop=-1:size=2e9,volume=0.15[music]`);
      audioFilters.push(`[music][1:a]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=200[duckedmusic]`);
      mixLabels.push("duckedmusic");
    }

    sfxEvents.forEach((ev, idx) => {
      const inputIdx = sfxIndices[idx];
      const ms = Math.round(ev.time * 1000);
      const label = `sfx${idx}`;
      audioFilters.push(`[${inputIdx}:a]volume=${ev.volume},adelay=${ms}|${ms}[${label}]`);
      mixLabels.push(label);
    });

    if (mixLabels.length > 1) {
      audioFilters.push(`[${mixLabels.join("][")}]amix=inputs=${mixLabels.length}:duration=first:normalize=0[final_a]`);
    }

    const allFilters = [videoFilter, ...audioFilters];
    finalCmd.complexFilter(allFilters);

    // Studio-grade final encoding:
    // - CRF 16 (higher quality source for YouTube's re-encode)
    // - Explicit BT.709 colorspace flags
    // - High profile for maximum quality at 1080p30
    finalCmd.outputOptions([
      "-map", "[final_v]",
      "-map", mixLabels.length > 1 ? "[final_a]" : "1:a",
      "-c:v", V_ENCODER,
      "-preset", "medium",
      "-crf", "16",
      "-profile:v", "high",
      "-level:v", "4.1",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ac", "2",
      "-shortest",
      "-movflags", "+faststart",
    ]);
    finalCmd.output(finalPath);
    await run(finalCmd);

    await fsp.copyFile(finalPath, outputFullPath);

    // Thumbnail: render a 1280x720 PNG from the passed thumbnail image + text.
    // Optional - a render failure never fails the video (falls back to auto-frame).
    let thumbnailPath = null;
    if (reqBody.thumbnail) {
      try {
        const thumbFull = path.join(OUTPUT_DIR, `thumb_${jobId}.png`);
        await buildThumbnail(reqBody.thumbnail.image_url, reqBody.thumbnail.text, reqBody.thumbnail.accent, tmpDir, thumbFull, reqBody.thumbnail.image_base64);
        thumbnailPath = thumbFull;
      } catch (e) {
        console.warn(`[job ${jobId}] thumbnail render failed (${e.message}) - continuing without a custom thumbnail`);
      }
    }

    const renderTimeSec = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[job ${jobId}] Done -> ${outputFullPath} (${renderTimeSec}s, ${degradedScenes} degraded scenes)`);
    return { success: true, output_path: outputFullPath, thumbnail_path: thumbnailPath, render_time_sec: renderTimeSec, degraded_scenes: degradedScenes, job_id: jobId };

  } catch (err) {
    console.error(`[job ${jobId}] FAILED:`, err);
    throw err;
  } finally {
    if (!process.env.DEBUG_KEEP_TMP) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
  }
}

// ---------------------------------------------------------------------------
// Async Job API
// ---------------------------------------------------------------------------

app.post("/compose", (req, res) => {
  const jobId = crypto.randomUUID();
  const tmpDir = newTmpDir();

  jobStore.set(jobId, { status: "processing", startedAt: Date.now() });

  runComposeJob(req.body, jobId, tmpDir)
    .then((result) => {
      jobStore.set(jobId, { status: "done", result, finishedAt: Date.now() });
    })
    .catch((err) => {
      jobStore.set(jobId, { status: "failed", error: err.message, finishedAt: Date.now() });
    });

  return res.status(202).json({ job_id: jobId, status: "processing" });
});

// Build a thumbnail on its own, without rendering a video.
//
// The same buildThumbnail() the /compose path uses, exposed directly. A
// thumbnail is the highest-leverage thing to iterate on and the cheapest thing
// to produce, so it must not be chained to a 10-minute render: changing five
// words of overlay text should cost seconds, not a full re-encode.
//
// Synchronous — no job store. This is image compositing, not video encoding.
app.post("/thumbnail", async (req, res) => {
  const tmpDir = newTmpDir();
  const outPath = path.join(tmpDir, "thumbnail.png");
  try {
    const { image_url = null, image_base64 = null, text = null, accent = null } = req.body || {};

    await buildThumbnail(image_url, text, accent, tmpDir, outPath, image_base64);

    const bytes = await fsp.readFile(outPath);
    return res.json({
      success: true,
      media_type: "image/png",
      width: 1280,
      height: 720,
      // Base64 rather than a file path: unlike a render, there is nothing to
      // keep on disk afterwards, and the caller wants the bytes.
      image_base64: bytes.toString("base64"),
      // buildThumbnail falls back to a gradient when the background cannot be
      // fetched. Report what was actually used, not what was asked for, so the
      // engine never records a stock background it did not get.
      background: lastThumbnailBackground(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
});

app.get("/compose-status/:jobId", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ status: "not_found", error: `No job with id ${req.params.jobId}` });
  }
  if (job.status === "done") {
    jobStore.delete(req.params.jobId);
    return res.json({ status: "done", success: true, ...job.result });
  }
  if (job.status === "failed") {
    jobStore.delete(req.params.jobId);
    return res.status(500).json({ status: "failed", success: false, error: job.error });
  }
  return res.json({ status: "processing" });
});

// Delete a finished render (and its thumbnail) from OUTPUT_DIR. The workflow
// passes the video filename stem, e.g. "long_<jobId>".
app.delete("/cleanup/:id", async (req, res) => {
  try {
    const stem = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, "");
    const jobId = stem.replace(/^long_/, "");
    const targets = [...new Set([`${stem}.mp4`, `long_${jobId}.mp4`, `thumb_${jobId}.png`])];
    let removed = 0;
    for (const name of targets) {
      const p = path.join(OUTPUT_DIR, name);
      if (fs.existsSync(p)) { await fsp.rm(p, { force: true }); removed++; }
    }
    return res.json({ success: true, removed });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Per-run metrics for the niche A/B. Appended as JSONL to the persistent data
// volume; GET returns all runs for later revenue-per-run analysis.
app.post("/run-log", async (req, res) => {
  try {
    await fsp.mkdir(path.dirname(RUN_LOG_PATH), { recursive: true });
    await fsp.appendFile(RUN_LOG_PATH, JSON.stringify({ ...req.body, logged_at: new Date().toISOString() }) + "\n");
    return res.json({ success: true });
  } catch (err) {
    console.error("Failed to append run log:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/run-log", async (req, res) => {
  try {
    if (!fs.existsSync(RUN_LOG_PATH)) return res.json({ runs: [] });
    const lines = (await fsp.readFile(RUN_LOG_PATH, "utf8")).split("\n").filter(Boolean);
    const runs = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    return res.json({ runs });
  } catch (err) {
    return res.status(500).json({ runs: [], error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Long-form compose engine listening on :${PORT}`));
