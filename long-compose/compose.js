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
const DEBUG_KEEP_TMP = /^(1|true|yes)$/i.test(process.env.DEBUG_KEEP_TMP || "");
const JOB_TTL_MS = Math.max(1000, Number(process.env.JOB_TTL_MS) || 2 * 60 * 60 * 1000);
const JOB_SWEEP_INTERVAL_MS = Math.max(1000, Math.min(JOB_TTL_MS, Number(process.env.JOB_SWEEP_INTERVAL_MS) || 5 * 60 * 1000));

// Completed/failed jobs used to live forever when a caller disappeared before polling.
// Active renders are never expired; only terminal jobs older than JOB_TTL_MS are swept.
const jobSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobStore) {
    if ((job.status === "done" || job.status === "failed") && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobStore.delete(id);
    }
  }
}, JOB_SWEEP_INTERVAL_MS);
jobSweepTimer.unref?.();

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

// TTS providers commonly leave 350-750ms of silence after every line. With
// one audio file per scene those tails accumulate into the stop-start rhythm
// seen in completed episodes. Preserve a deliberate response beat (160ms for
// an ordinary turn, within the 120-250ms range that reads as a natural reply
// rather than a hard stop) while trimming only the trailing pad; leading
// timing stays untouched, so lip sync remains stable. A scene that hands off
// into a reversal or the payoff keeps a longer beat instead (see
// REVERSAL_TAIL_SILENCE_SECONDS below) -- collapsing that pause to the same
// 160ms as any other turn would erase the one place a pause is actually
// doing narrative work.
//
// Bounded and measured, not trusted blindly: silenceremove's -42dB threshold
// cannot tell a genuine trailing pad from a quiet final phoneme, a breath, or
// a deliberate dramatic pause -- amplitude alone doesn't know intent. A run
// that trimmed more than MAX_TAIL_TRIM_SECONDS is treated as having caught
// something that wasn't just padding and is discarded in favour of the
// original file, rather than shipping a clipped ending. The trim also no
// longer silently invalidates the alignment: the caller receives the actual
// seconds removed so it can clamp the scene's own caption/lip-sync timestamps
// to the new duration instead of letting them run past a now-shorter clip and
// bleed captions into the following scene.
const MAX_TAIL_TRIM_SECONDS = 0.35;
// Longer preserved beat before a scene hands off into a contradiction or the
// payoff -- the reversal needs a breath the surrounding ordinary turns don't.
const REVERSAL_TAIL_SILENCE_SECONDS = 0.45;

async function tightenExplanationTail(audioPath, preserveSilenceSeconds = 0.16) {
  const trimmed = `${audioPath}.tight.mp3`;
  try {
    const before = await ffprobeDuration(audioPath);
    await execFileAsync(ffmpegPath, [
      "-y", "-i", audioPath,
      "-af", `areverse,silenceremove=start_periods=1:start_duration=0.18:start_threshold=-42dB:start_silence=${preserveSilenceSeconds},areverse`,
      // 192k, not the original 128k: this is already a second lossy encode
      // over the TTS provider's own compression, so re-encoding at a lower
      // bitrate than typical source quality would compound the loss for no
      // reason connected to the actual goal (removing dead air).
      "-c:a", "libmp3lame", "-b:a", "192k", trimmed,
    ]);
    const after = await ffprobeDuration(trimmed);
    const removed = before - after;
    if (!(after > 0) || removed > MAX_TAIL_TRIM_SECONDS) {
      await fsp.unlink(trimmed).catch(() => {});
      console.warn(`[audio] trailing-silence trim discarded: removed ${removed.toFixed(3)}s exceeds the ${MAX_TAIL_TRIM_SECONDS}s safety bound`);
      return 0;
    }
    await fsp.rename(trimmed, audioPath);
    return removed;
  } catch (error) {
    await fsp.unlink(trimmed).catch(() => {});
    console.warn(`[audio] trailing-silence trim skipped: ${error.message}`);
    return 0;
  }
}

// Pulls a scene's trailing alignment timestamps in to match audio that was
// shortened by `trimmedSeconds`. Without this, a caption or viseme timed
// against the pre-trim audio can extend past the clip's actual end and either
// render over black or bleed into the next scene's audio.
function clampAlignmentToDuration(alignment, trimmedSeconds) {
  if (!trimmedSeconds || !alignment || typeof alignment !== "object") return alignment;
  const newDuration = Math.max(0, (Array.isArray(alignment.character_end_times_seconds) && alignment.character_end_times_seconds.length
    ? alignment.character_end_times_seconds[alignment.character_end_times_seconds.length - 1]
    : Infinity) - trimmedSeconds);
  const clamp = (arr) => Array.isArray(arr) ? arr.map((t) => Math.min(t, newDuration)) : arr;
  return {
    ...alignment,
    character_start_times_seconds: clamp(alignment.character_start_times_seconds),
    character_end_times_seconds: clamp(alignment.character_end_times_seconds),
  };
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

// Thumbnail result metadata is returned from buildThumbnail() per request.
// Do not store it in process globals: concurrent /thumbnail calls otherwise race.

/**
 * Lay out thumbnail text as a left-hand column of stacked capitals.
 *
 * Modelled on the channel's own thumbnail style: the type occupies the left
 * side in big stacked caps, the photograph keeps the right, and the words that
 * carry the hook are picked out in the accent colour while the connective words
 * stay white. Centring a single line across the bottom — what this did before —
 * competes with the image instead of sitting beside it, and gives every episode
 * the same flat emphasis.
 *
 * Lines are broken so each one is a single colour. That is what makes the
 * two-tone readable: mixing colours mid-line needs per-word positioning, and
 * ffmpeg cannot measure a string before drawing it.
 */
function layoutThumbnailText(raw, emphasis, colWidth) {
  const clean = (v) =>
    String(v || "").replace(/[\\':]/g, " ").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

  const text = clean(raw).toUpperCase();
  if (!text) return { lines: [], colWidth: 0 };

  const emph = clean(emphasis).toUpperCase();
  const COL_W = colWidth || 500;   // set from the photo, not fixed
  // Uppercase Inter-Black, not mixed case: capitals carry noticeably more
  // advance, and the 0.62 tuned for sentence case let ANCIENT run past the
  // safe margin on its first real render.
  const CHAR_W = 0.70;
  // Guideline ranges: headline 90-160, secondary 45-80, at most three lines.
  const MAX_SIZE = 160;
  const MIN_HEADLINE = 90;
  const MIN_SIZE = 45;
  const MAX_SECONDARY = 80;
  const MAX_LINES = 3;

  // Split into [before, emphasis, after] so an emphasised run stays whole.
  let segments;
  const at = emph ? text.indexOf(emph) : -1;
  if (at >= 0) {
    segments = [
      { words: text.slice(0, at).trim().split(/\s+/).filter(Boolean), hot: false },
      { words: emph.split(/\s+/).filter(Boolean), hot: true },
      { words: text.slice(at + emph.length).trim().split(/\s+/).filter(Boolean), hot: false },
    ].filter((s) => s.words.length > 0);
  } else {
    // No usable emphasis: treat the whole thing as the hook rather than
    // inventing one, so it still reads as deliberate.
    segments = [{ words: text.split(/\s+/).filter(Boolean), hot: true }];
  }

  // Wrap each segment independently — a segment boundary is always a line break.
  const sizeFor = (chars) => Math.floor(COL_W / (CHAR_W * Math.max(chars, 1)));
  const lines = [];
  for (const seg of segments) {
    let current = [];
    for (const word of seg.words) {
      const candidate = [...current, word].join(" ");
      // Keep the hook large: break early rather than shrink it to fit.
      if (current.length > 0 && sizeFor(candidate.length) < (seg.hot ? MIN_HEADLINE : 58)) {
        lines.push({ text: current.join(" "), hot: seg.hot });
        current = [word];
      } else {
        current.push(word);
      }
    }
    if (current.length > 0) lines.push({ text: current.join(" "), hot: seg.hot });
  }

  // Too many lines: merge the quietest neighbours until it fits.
  while (lines.length > MAX_LINES) {
    let idx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].hot === lines[i + 1].hot) { idx = i; break; }
    }
    if (idx === -1) idx = 0;
    lines[idx] = {
      text: `${lines[idx].text} ${lines[idx + 1].text}`,
      hot: lines[idx].hot || lines[idx + 1].hot,
    };
    lines.splice(idx + 1, 1);
  }

  // Size each group to the column, then let the hook dominate.
  const longest = (hot) =>
    Math.max(0, ...lines.filter((l) => l.hot === hot).map((l) => l.text.length));
  const hotSize = Math.min(sizeFor(longest(true) || 1), MAX_SIZE);
  const coolFit = longest(false) ? sizeFor(longest(false)) : MAX_SECONDARY;
  const coolSize = Math.max(
    MIN_SIZE,
    Math.min(Math.round(hotSize * 0.58), coolFit, MAX_SECONDARY),
  );

  for (const l of lines) l.size = Math.max(MIN_SIZE, l.hot ? hotSize : coolSize);
  return { lines, colWidth: COL_W };
}

/**
 * Read the photograph before deciding where the type goes.
 *
 * The layout pattern is fixed — stacked capitals, hook in the accent colour,
 * connectives in white — but the position and size are not. Stock search
 * returns whatever it returns: sometimes the subject is on the right and the
 * left is open sky, sometimes the reverse. Committing to one side means half
 * the thumbnails bury their own subject under the headline.
 *
 * So: downscale to a coarse grid of edge energy and brightness, and put the
 * text where the picture is quietest. Cheap — one extra ffmpeg pass on a single
 * frame — and it is the difference between a layout that happens to work on the
 * photo you tested and one that works on the photo you get.
 */
async function analyseBackground(bin, bgPath) {
  const COLS = 8, ROWS = 4;
  const read = async (pre) => {
    const { stdout } = await execFileAsync(
      bin,
      ["-v", "error", "-i", bgPath, "-vf", `${pre}scale=${COLS}:${ROWS},format=gray`,
       "-frames:v", "1", "-f", "rawvideo", "-"],
      { encoding: "buffer", timeout: 30000, maxBuffer: 1 << 20 },
    );
    return Array.from(stdout.subarray(0, COLS * ROWS));
  };

  // edgedetect first: busyness matters more than brightness for legibility.
  const [detail, luma] = await Promise.all([read("edgedetect=low=0.1:high=0.3,"), read("")]);

  const half = (cells, from, to) => {
    let sum = 0, n = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = from; c < to; c++) { sum += cells[r * COLS + c]; n++; }
    }
    return n ? sum / n : 0;
  };

  const leftDetail = half(detail, 0, Math.floor(COLS / 2));
  const rightDetail = half(detail, Math.ceil(COLS / 2), COLS);
  const side = leftDetail <= rightDetail ? "left" : "right";

  return {
    side,
    // Busyness of the side the type will sit on, which decides whether
    // darkening is enough or the region needs blurring too.
    sideDetail: side === "left" ? leftDetail : rightDetail,
    // How lopsided the picture is. A near-tie means neither side is really
    // clear, so the scrim has to work harder.
    contrastGap: Math.abs(leftDetail - rightDetail),
    brightness: half(luma, 0, COLS) / 255,
    sideBrightness: (side === "left" ? half(luma, 0, 4) : half(luma, 4, COLS)) / 255,
  };
}

/**
 * A left-to-right scrim: dark under the type, clear over the photograph.
 *
 * Vertical columns rather than one box. A single drawbox left a hard edge down
 * the middle of the frame; stepping the alpha hides the boundary, and the type
 * stays legible whatever the stock photo happens to have on its left side —
 * which we cannot choose, since the search returns what it returns.
 */
function scrimFilters(side, width, maxAlpha, steps = 64) {
  const band = Math.ceil(width / steps);
  const out = [];
  for (let i = 0; i < steps; i++) {
    // Densest against the edge the type sits on, fading toward the subject.
    // 1.6 rather than a square: the steeper ramp turned the corner of a bright
    // photo almost black where there was no text to justify it.
    const alpha = (maxAlpha * Math.pow(1 - i / steps, 1.6)).toFixed(3);
    const x = side === "left" ? i * band : 1280 - (i + 1) * band;
    out.push(`drawbox=x=${x}:y=0:w=${band}:h=720:color=black@${alpha}:t=fill`);
  }
  return out;
}

async function buildThumbnail(imageUrl, text, accent, tmpDir, outPath, imageBase64, emphasis) {
  let bgPath;
  let thumbnailBackground = "gradient";
  if (imageBase64) {
    bgPath = path.join(tmpDir, `thumb_bg_${crypto.randomUUID()}.png`);
    await writeBase64(imageBase64, bgPath);
    thumbnailBackground = "supplied";
  } else if (imageUrl) {
    bgPath = path.join(tmpDir, `thumb_bg_${crypto.randomUUID()}.png`);
    try {
      await downloadFile(imageUrl, bgPath);
      thumbnailBackground = "supplied";
    } catch (e) { bgPath = pickGradientBackground(); }
  } else {
    bgPath = pickGradientBackground();
  }

  const fontPath = path.join(MOTION_ASSETS_DIR, "fonts", "Inter-Black.ttf");
  const safeFont = fontPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const accentHex = "0x" + String(accent || "#FFC712").replace(/^#/, "");

  const textBin = textFfmpegPath();
  if (!textBin) {
    throw new Error(
      "no ffmpeg with the drawtext filter is available; cannot render thumbnail text",
    );
  }

  // Decide the composition from the photograph rather than assuming one.
  let look = { side: "left", sideDetail: 0, contrastGap: 0, brightness: 0.5, sideBrightness: 0.5 };
  try {
    look = await analyseBackground(textBin, bgPath);
  } catch (e) {
    console.warn(`[thumbnail] background analysis failed (${e.message}) — defaulting to a left column`);
  }

  // A busy or bright side needs a narrower column and a heavier scrim; an open
  // sky can carry wider type.
  // Text region 36-41% of the frame, inside the 30-45% guideline. The wider
  // option is only taken when the picture is clearly lopsided and the quiet
  // side can genuinely spare it.
  const colWidth = look.contrastGap > 12 ? 520 : 460;
  const scrimAlpha = Math.min(0.84, 0.62 + look.sideBrightness * 0.22);

  const { lines } = layoutThumbnailText(text, emphasis, colWidth);

  const MARGIN = 56;
  const LEFT = look.side === "left" ? MARGIN : 1280 - MARGIN - colWidth;

  // YouTube stamps the duration in the bottom-right of every thumbnail. On a
  // right-hand column the last line can land under it, so the block is clamped
  // above that zone rather than trusting vertical centring to stay clear.
  const BADGE_TOP = 620;
  const lineGap = 0.06;
  const blockH = lines.reduce((h, l, i) => h + l.size + (i ? l.size * lineGap : 0), 0);
  let y = Math.max(28, Math.round((720 - blockH) / 2));
  if (look.side === "right" && y + blockH > BADGE_TOP) {
    y = Math.max(28, BADGE_TOP - blockH);
  }

  const textFilters = lines.map((l) => {
    const thisY = Math.round(y);
    y += l.size * (1 + lineGap);
    const border = Math.max(5, Math.round(l.size * 0.055));
    const colour = l.hot ? accentHex : "white";
    return (
      `drawtext=fontfile='${safeFont}':text='${l.text.replace(/'/g, "")}'` +
      `:fontcolor=${colour}:fontsize=${l.size}` +
      `:borderw=${border}:bordercolor=black@0.9` +
      `:shadowcolor=black@0.6:shadowx=${Math.round(l.size * 0.04)}:shadowy=${Math.round(l.size * 0.05)}` +
      `:x=${LEFT}:y=${thisY}`
    );
  });

  const base = [
    "scale=1280:720:force_original_aspect_ratio=increase",
    "crop=1280:720",
    "eq=contrast=1.22:saturation=1.45:brightness=0.02",
    "unsharp=5:5:0.8",
    "vignette=PI/5",
  ].join(",");

  const overlays = [...scrimFilters(look.side, colWidth + 220, scrimAlpha), ...textFilters].join(",");

  // Darkening alone stops working when the type sits over fine detail — a
  // gravel field or foliage keeps punching through the scrim. Blur only that
  // region, and only when the analysis says it is busy, so a clean sky is left
  // sharp.
  const blurW = colWidth + 120;
  const blurX = look.side === "left" ? 0 : 1280 - blurW;
  const needsBlur = look.sideDetail > 26;

  const vf = needsBlur
    ? `${base},split[bg][cut];[cut]crop=${blurW}:720:${blurX}:0,boxblur=12:1[blur];` +
      `[bg][blur]overlay=${blurX}:0,${overlays}`
    : `${base},${overlays}`;

  const filterFlag = needsBlur ? "-filter_complex" : "-vf";

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
    filterFlag, vf,
    "-frames:v", "1",
    outPath,
  ], { timeout: 60000 });
  console.log(
    `[thumbnail] ${look.side} column, ${lines.length} line(s), ` +
    `detail=${look.sideDetail.toFixed(1)}${needsBlur ? " (blurred)" : ""} ` +
    `brightness=${look.sideBrightness.toFixed(2)}`,
  );
  const layout = {
    side: look.side,
    lines: lines.length,
    headline_px: Math.max(0, ...lines.filter((l) => l.hot).map((l) => l.size)),
    secondary_px: Math.max(0, ...lines.filter((l) => !l.hot).map((l) => l.size)),
    // Estimated, not measured — ffmpeg cannot report drawn extents. Enough to
    // catch a line that has run past its column.
    overflow_px: Math.max(
      0,
      ...lines.map((l) => Math.round(l.text.length * 0.70 * l.size) - colWidth),
    ),
    blurred: needsBlur,
    text_region_pct: Math.round((colWidth / 1280) * 100),
  };
  return { path: outPath, background: thumbnailBackground, layout };
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

async function renderRemotion(compositionId, outputPath, durationSec, props) {
  const bridgePath = path.join(REMOTION_DIR, "render-bridge.mjs");

  // Write props to a temp file to avoid E2BIG when props contain large
  // base64 images. UUID keeps concurrent scene renders collision-free.
  const propsFile = path.join(path.dirname(outputPath), `props_${crypto.randomUUID()}.json`);
  await fsp.writeFile(propsFile, JSON.stringify(props));

  const args = [
    bridgePath,
    compositionId,
    outputPath,
    String(durationSec),
    `@${propsFile}`,
  ];

  console.log(`[remotion] Rendering ${compositionId} (${durationSec}s)...`);
  try {
    const { stdout, stderr } = await execFileAsync("node", args, {
      cwd: REMOTION_DIR,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout) console.log("[remotion stdout]", stdout);
    if (stderr) console.log("[remotion stderr]", stderr);
    return outputPath;
  } catch (err) {
    console.error("[remotion] Render failed:", err.message);
    throw err;
  } finally {
    await fsp.unlink(propsFile).catch(() => {});
  }
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
// Lip-sync (Rhubarb Lip Sync CLI) — cartoon scenes only
// ---------------------------------------------------------------------------

// Probed once, like textFfmpegPath() above: try the configured/installed
// location, cache the result. Missing binary is not fatal — a cartoon scene
// without cues just renders with a closed/neutral mouth the whole time.
let _rhubarbPath;
function rhubarbPath() {
  if (_rhubarbPath !== undefined) return _rhubarbPath;
  const candidates = [process.env.RHUBARB_PATH, "/usr/local/bin/rhubarb", "rhubarb"].filter(Boolean);
  _rhubarbPath = candidates.find((bin) => {
    try {
      require("child_process").execFileSync(bin, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }) || null;
  if (!_rhubarbPath) {
    console.warn(
      "[lipsync] rhubarb binary not found — cartoon scenes will render with a closed/neutral " +
      "mouth. Set RHUBARB_PATH or install rhubarb-lip-sync.",
    );
  }
  return _rhubarbPath;
}

// Runs Rhubarb against a scene's narration audio and returns its mouthCues
// ([{start,end,value}], seconds). `dialogText` (the narration transcript, if
// known) is optional but improves phoneme accuracy — passed via Rhubarb's
// --dialogFile flag. Any failure (missing binary, bad audio, non-zero exit,
// unparseable output) degrades to an empty cue list rather than failing the
// scene — the puppet just doesn't animate its mouth, same as any other
// degraded-asset case in this pipeline.
async function generateMouthCues(audioPath, dialogText, tmpDir) {
  const bin = rhubarbPath();
  if (!bin) return [];

  const wavPath = path.join(tmpDir, `lipsync_${crypto.randomUUID()}.wav`);
  const cuesPath = path.join(tmpDir, `lipsync_${crypto.randomUUID()}.json`);
  let dialogFilePath = null;

  try {
    // Rhubarb reads WAV/Ogg, not the MP3 the voice provider returns.
    await run(
      ffmpeg().input(audioPath).outputOptions(["-ar", "22050", "-ac", "1"]).output(wavPath),
    );

    const args = ["-f", "json", "-o", cuesPath];
    if (dialogText && dialogText.trim()) {
      dialogFilePath = path.join(tmpDir, `lipsync_${crypto.randomUUID()}.txt`);
      await fsp.writeFile(dialogFilePath, dialogText);
      args.push("--dialogFile", dialogFilePath);
    }
    args.push(wavPath);

    await execFileAsync(bin, args, { timeout: 60000 });
    const raw = JSON.parse(await fsp.readFile(cuesPath, "utf8"));
    const cues = Array.isArray(raw.mouthCues) ? raw.mouthCues : [];
    // Sort once here rather than per-frame in mouthAtTime (called every
    // rendered frame): mouthAtTime's lookup picks the first array-order
    // match, not the temporally-earliest one, so out-of-order cues (a
    // malformed Rhubarb run, or a hand-edited cue file) would otherwise
    // silently select the wrong mouth shape at a given timestamp.
    cues.sort((a, b) => a.start - b.start);
    return cues;
  } catch (err) {
    console.warn(`[lipsync] rhubarb failed (${err.message}) — falling back to neutral mouth`);
    return [];
  } finally {
    fsp.unlink(wavPath).catch(() => {});
    fsp.unlink(cuesPath).catch(() => {});
    if (dialogFilePath) fsp.unlink(dialogFilePath).catch(() => {});
  }
}

// Which of a cartoon background's back/middle/front layers actually exist on
// disk, checked here (not in the browser) so a variant that only ships e.g.
// back.svg never 404s inside the headless Chrome render. A location/variant
// with no files at all resolves to all-false, and CartoonScene falls back to
// its plain mood gradient — the same behaviour as before backgrounds existed.
function resolveBackgroundLayers(background) {
  if (!background || background.flat || !background.location || !background.variant) return background;
  const dir = path.join(REMOTION_DIR, "public", "backgrounds", background.location, background.variant);
  const layers = {
    back: fs.existsSync(path.join(dir, "back.svg")),
    middle: fs.existsSync(path.join(dir, "middle.svg")),
    front: fs.existsSync(path.join(dir, "front.svg")),
  };
  return { ...background, layers };
}

// ---------------------------------------------------------------------------
// Template Scene Processing (Remotion — studio motion graphics)
// ---------------------------------------------------------------------------

async function buildTemplateScene(templateName, templateData, duration, audioPath, outPath, tmpDir, mood, bgImagePath = null, dialogText = null) {
  // Seven categories, one battle-tested composition each — deliberately no
  // random pool. A pool of look-alike components sharing one generic prop
  // shape meant most renders silently fell back to a component's own
  // hardcoded placeholder text, because the shared shape didn't actually
  // match what that particular component reads. One fixed composition per
  // category, with props mapped from its *exact* fields, means what the
  // visual planner asks for is what actually renders — every time.
  //
  // Each buildProps mirrors the template_data shape documented in
  // engine/prompts/visual_planner for that category.
  const categoryMap = {
    timeline: {
      compositionId: "DataTimeline",
      buildProps: (d) => ({ events: d.events, title: d.title }),
    },
    ranking: {
      compositionId: "DataRanking",
      // The component numbers each row itself; the AI only supplies name+value.
      buildProps: (d) => ({
        items: (d.items || []).map((it, i) => ({ rank: i + 1, name: it.name, value: it.value })),
        title: d.title,
      }),
    },
    chart: {
      compositionId: "DataBarChart",
      buildProps: (d) => ({ items: d.items, title: d.title }),
    },
    list: {
      compositionId: "ListNumberedVertical",
      buildProps: (d) => ({ items: (d.items || []).map((text) => ({ text })), title: d.title }),
    },
    counter: {
      compositionId: "StatReveal",
      // A pre-formatted display string ("4,300 km", "3.5x") beats a raw
      // from/to/unit split — it lets the AI pick whatever format actually
      // reads well, and StatReveal just displays it.
      buildProps: (d) => ({ statValue: d.value, label: d.label }),
    },
    comparison: {
      compositionId: "Comparison",
      buildProps: (d) => ({
        leftLabel: d.leftLabel, leftValue: d.leftValue,
        rightLabel: d.rightLabel, rightValue: d.rightValue,
      }),
    },
    text: {
      compositionId: "KineticText",
      buildProps: (d) => ({ line: d.text }),
    },
    explanation: {
      compositionId: "ExplanationScene",
      buildProps: (d) => ({
        role: d.role,
        visualOperation: d.visualOperation,
        visualPrimitive: d.visualPrimitive || "objects",
        numericValue: Number.isFinite(d.numericValue) ? d.numericValue : null,
        visualState: d.visualState || "mechanism",
        compositionMode: d.compositionMode || "full-model",
        title: d.title,
        keyText: d.keyText,
        elements: d.elements || [],
        // Parallel to elements: a stable identity key per entity, independent
        // of the exact display casing/wording a given scene happens to use.
        // Without this the renderer hashed shape/colour off the raw display
        // text, so the same entity referred to with different capitalization
        // across scenes (a real, common variance) got a different shape --
        // "canonical reuse across the episode" broke on formatting alone.
        entityIdentityKeys: d.entityIdentityKeys || [],
        // Real icons resolved server-side (engine/src/icon-search.ts, via
        // Iconify's open icon search) for entities whose label matched
        // something concrete. Keyed the same way as entityIdentityKeys;
        // EntityMark prefers this over its hash-picked shape when present.
        entityIcons: d.entityIcons || {},
        // The authored connections between those entities (their `kind` is
        // what lets a diagram draw "A blocks B" rather than an arrow that
        // says the opposite). Indices address `elements` above. An absent or
        // malformed list falls back to the renderer's previous fixed
        // topology, so an old plan renders exactly as it did before.
        modelRelations: Array.isArray(d.modelRelations) ? d.modelRelations : [],
        before: d.before,
        after: d.after,
        characterCutIn: d.characterCutIn || "none",
        soundCue: d.soundCue || "none",
        characters: d.characters || [],
      }),
    },
    cartoon: {
      compositionId: "CartoonScene",
      buildProps: (d) => ({
        background: resolveBackgroundLayers(d.background),
        camera: d.camera,
        characters: d.characters || [],
        visualEvent: d.visualEvent,
        speakerEmphasis: d.speakerEmphasis,
        // Explanation direction must survive the production bridge: prop inserts
        // and reaction framing make the visual model readable, not decorative.
        shotType: d.shotType || d.framing,
        visualStyle: d.visualStyle || d.visual_style,
        cinematic: d.cinematic,
      }),
    },
  };

  // Direct composition names, from before categories existed. Kept as a
  // literal escape hatch — each still needs its own field names read.
  const directMap = {
    stat_reveal: "StatReveal",
    comparison: "Comparison",
    kinetic_text: "KineticText",
  };

  // Parse template_data if it's still a string (shouldn't be, but defensive)
  const parsedData = typeof templateData === "string" ? JSON.parse(templateData) : (templateData || {});

  let compositionId;
  let props;
  const category = categoryMap[templateName];
  if (category) {
    compositionId = category.compositionId;
    props = { mood: mood || "neutral", ...category.buildProps(parsedData) };
    console.log(`[template] category "${templateName}" → "${compositionId}"`);
  } else if (directMap[templateName]) {
    compositionId = directMap[templateName];
    props = { mood: mood || "neutral", ...parsedData };
  } else {
    // Unknown name: assume it's a literal composition ID and pass data through.
    compositionId = templateName;
    props = { mood: mood || "neutral", ...parsedData };
  }

  // Cartoon scenes lip-sync whichever character(s) are marked isSpeaking —
  // Rhubarb runs against this scene's own narration audio, computed here
  // (not by the caller) since mouth cues are a render-time detail, not
  // something the story/planning pipeline needs to know about.
  if ((templateName === "cartoon" || templateName === "explanation") && Array.isArray(props.characters)) {
    const cues = await generateMouthCues(audioPath, dialogText, tmpDir);
    props.characters = props.characters.map((c) => (c.isSpeaking ? { ...c, mouthCues: cues } : c));
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

  // Legacy field names for the three direct-name templates, only when reached
  // by their old literal name rather than through a category above.
  if (!category && compositionId === "StatReveal") {
    props.statValue = templateData?.statValue || props.statValue || "";
    props.label = templateData?.label || props.label || "";
    props.icon = templateData?.icon || "activity";
  } else if (!category && compositionId === "Comparison") {
    props.leftLabel = templateData?.leftLabel || "";
    props.leftValue = templateData?.leftValue || "";
    props.rightLabel = templateData?.rightLabel || "";
    props.rightValue = templateData?.rightValue || "";
  } else if (!category && compositionId === "KineticText") {
    props.line = templateData?.line || props.line || "";
  }

  // Render template via Remotion (full-screen, no image composite).
  // Templates look best on their own dark backgrounds. Overlaying on images
  // makes text harder to read and panels invisible. The visual planner should
  // use templates for data-heavy scenes and images for atmospheric scenes —
  // mixing them in a single frame adds complexity without visual benefit.
  const templateVideoPath = path.join(tmpDir, `remotion_${compositionId}_${crypto.randomUUID()}.mp4`);
  await renderRemotion(compositionId, templateVideoPath, duration, props);

  // Mux template video with narration. Remotion already renders H.264 at the
  // target geometry/fps, so copy video directly whenever it is long enough.
  // Re-encode only when a short render actually needs tpad.
  const templateDuration = await ffprobeDuration(templateVideoPath);
  const needsPadding = templateDuration + 0.05 < duration;

  await runAudioMux((normalize) => {
    if (!needsPadding) {
      const opts = ["-map", "0:v", "-map", "1:a", "-t", String(duration)];
      if (normalize) opts.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
      opts.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k");
      return ffmpeg()
        .input(templateVideoPath)
        .input(audioPath)
        .outputOptions(opts)
        .output(outPath);
    }

    const padDuration = Math.max(0, duration - templateDuration + 0.1).toFixed(3);
    const videoFilter = `[0:v]tpad=stop_mode=clone:stop_duration=${padDuration}[padded]`;
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


// User text must never be allowed to inject ASS override blocks. Replace the
// characters that carry ASS control syntax while preserving readable content.
function escapeAssText(value) {
  return String(value ?? "")
    .replace(/\\/g, "＼")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

// ASS colours are &H00BBGGRR (BGR, byte-reversed from the #RRGGBB the engine
// sends). Falls back to plain white - same as the Caption style's own
// PrimaryColour - if the value isn't a real hex color.
function hexToAssColor(hex) {
  const m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(String(hex ?? ""));
  if (!m) return "&H00FFFFFF";
  const [, r, g, b] = m;
  return `&H00${b}${g}${r}`.toUpperCase();
}

function validatedAlignment(alignment, sceneIdx) {
  if (!alignment) return null;
  const rawChars = alignment.characters;
  const chars = Array.isArray(rawChars)
    ? rawChars
    : (typeof rawChars === "string" ? [...rawChars] : []);
  const starts = Array.isArray(alignment.character_start_times_seconds)
    ? alignment.character_start_times_seconds
    : [];
  const ends = Array.isArray(alignment.character_end_times_seconds)
    ? alignment.character_end_times_seconds
    : [];

  const length = Math.min(chars.length, starts.length, ends.length);
  if (!length) return null;
  if (chars.length !== starts.length || chars.length !== ends.length) {
    console.warn(
      `[captions] scene ${sceneIdx}: alignment length mismatch ` +
      `(chars=${chars.length}, starts=${starts.length}, ends=${ends.length}); truncating to ${length}`,
    );
  }

  const cleanChars = [];
  const cleanStarts = [];
  const cleanEnds = [];
  for (let i = 0; i < length; i++) {
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      console.warn(`[captions] scene ${sceneIdx}: dropping invalid alignment entry ${i}`);
      continue;
    }
    cleanChars.push(String(chars[i] ?? ""));
    cleanStarts.push(start);
    cleanEnds.push(end);
  }

  return cleanChars.length
    ? { characters: cleanChars, character_start_times_seconds: cleanStarts, character_end_times_seconds: cleanEnds }
    : null;
}

function buildAssFromAlignment(scenes, offsets, commentHook, totalDuration) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${TARGET_W}
PlayResY: ${TARGET_H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Inter Bold,80,&H00FFFFFF,&H0000DFFF,&H50000000,&HA0000000,0,0,0,0,100,100,0,0,1,5,4,2,110,110,194,1
Style: CommentHook,Inter Bold,54,&H00FFFFFF,&H000000FF,&H40202020,&HC0000000,0,0,0,0,100,100,0,0,3,0,4,2,80,80,680,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = "";
  // Keep mobile captions short, large, and above the bottom UI-safe area.
  const WORDS_PER_PHRASE = 5;

  scenes.forEach((scene, sceneIdx) => {
    if (isOutroScene(scene)) return;
    const alignment = validatedAlignment(scene?.audio?.alignment, sceneIdx);
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

    // Preserve character identity through caption color without printing
    // production speaker-name prefixes into the viewer-facing line.
    const hasSpeaker = typeof scene?.speaker_name === "string" && scene.speaker_name.trim().length > 0;
    const speakerColorTag = hasSpeaker ? `{\\1c${hexToAssColor(scene.speaker_color)}}` : "";

    // Group words into phrases
    for (let phraseStart = 0; phraseStart < words.length; phraseStart += WORDS_PER_PHRASE) {
      const phrase = words.slice(phraseStart, phraseStart + WORDS_PER_PHRASE);
      if (!phrase.length || phrase[0].start == null) continue;

      const phraseBegin = phrase[0].start + offsets[sceneIdx];
      const phraseEnd = phrase[phrase.length - 1].end + offsets[sceneIdx];

      // One dialogue line per phrase. All words visible for the entire duration.
      // Use ASS \kf (smooth karaoke fill) to progressively highlight each word
      // in the CaptionHL color as it's spoken.
      let line = speakerColorTag;
      for (let w = 0; w < phrase.length; w++) {
        const word = phrase[w];
        // \kf duration is in centiseconds (100ths of a second)
        const wordDurationCs = Math.round((word.end - word.start) * 100);
        line += `{\\kf${wordDurationCs}}${escapeAssText(word.text)} `;
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
    const escaped = escapeAssText(commentHook);
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
    const alignment = validatedAlignment(scene?.audio?.alignment, sceneIdx);
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

  // The concat DEMUXER (-f concat, -c copy) stream-copies packets and simply
  // offsets timestamps between segments -- it assumes every segment shares a
  // consistent timebase. Scene segments here come from two different encode
  // paths (Remotion's own H.264 stream, copied straight through by
  // buildTemplateScene's "-c:v copy" branch, vs. libx264 re-encodes with
  // setpts/tpad/crop filters from buildImageScene/buildStockVideoScene), and
  // their timebases and SAR (sample aspect ratio) don't reliably agree --
  // buildImageScene's scale+crop chain leaves a near-1:1-but-not-exact SAR
  // (e.g. 28000:27999) instead of Remotion's clean 1:1. A real production
  // render (run_9989c55b) hit this directly: every individual
  // scene_N_final.mp4 was independently verified correct (Remotion given the
  // right frame count, each scene's own "-t duration" mux correct, and the
  // pipeline's own totalVideoDuration/fade-out math agreeing on ~60.7s) but
  // the concat-demuxer output still came out to 346-374s -- several minutes
  // of black screen with only the looped background music audible, because
  // "-c copy" silently produced a corrupted/gapped timeline across segments
  // it never actually validated as compatible.
  //
  // The concat FILTER decodes and re-times every segment before re-encoding,
  // so it can't inherit an upstream segment's timebase quirks -- but it DOES
  // strictly validate that every input's video parameters match, so the same
  // SAR mismatch that "-c copy" silently ignored makes the filter graph fail
  // outright ("Input link parameters do not match") unless every input is
  // first normalized. scale+setsar per input does that; the CPU cost of one
  // re-encode pass is worth never publishing this bug again.
  const filterInputs = scenePaths
    .map((_, i) => `[${i}:v]scale=${TARGET_W}:${TARGET_H},setsar=1,format=yuv420p[v${i}];[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`)
    .join(";");
  const concatInputs = scenePaths.map((_, i) => `[v${i}][a${i}]`).join("");
  const cmd = ffmpeg();
  for (const p of scenePaths) cmd.input(p);
  await run(
    cmd
      .complexFilter([`${filterInputs};${concatInputs}concat=n=${scenePaths.length}:v=1:a=1[cv][ca]`])
      .outputOptions([
        "-map", "[cv]",
        "-map", "[ca]",
        "-c:v", V_ENCODER,
        "-r", String(FPS),
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
      ])
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

function sceneTemplateData(scene) {
  const data = scene?.template_data;
  if (data && typeof data === "object") return data;
  if (typeof data === "string") {
    try { return JSON.parse(data) || {}; } catch { return {}; }
  }
  return {};
}

function isOutroScene(scene) {
  return sceneTemplateData(scene).is_outro === true;
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
    const outroIndexes = scenes
      .map((scene, index) => (isOutroScene(scene) ? index : -1))
      .filter((index) => index >= 0);
    if (outroIndexes.length > 1) {
      throw new Error(`Expected at most one outro scene, found ${outroIndexes.length}`);
    }
    if (outroIndexes.length === 1) {
      const outroIndex = outroIndexes[0];
      if (outroIndex !== scenes.length - 1) {
        const [outro] = scenes.splice(outroIndex, 1);
        scenes.push(outro);
        console.warn(`[job ${jobId}] moved script outro from index ${outroIndex} to final position`);
      }
    } else {
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

      if (scene?.template_name === "explanation" && !isOutroScene(scene)) {
        // A hard cut carries the pause; the next scene's own state tells us
        // whether this handoff is an ordinary turn or a reversal/payoff about
        // to land, since a scene doesn't know its own successor.
        const nextData = sceneTemplateData(scenes[i + 1]);
        const nextIsReversal = nextData.visualState === "contradiction" || nextData.visualState === "payoff";
        const trimmedSeconds = await tightenExplanationTail(
          audioPath,
          nextIsReversal ? REVERSAL_TAIL_SILENCE_SECONDS : 0.16,
        );
        if (trimmedSeconds > 0 && scene?.audio?.alignment) {
          scene.audio.alignment = clampAlignmentToDuration(scene.audio.alignment, trimmedSeconds);
        }
      }

      const duration = await ffprobeDuration(audioPath);
      const outPath = path.join(tmpDir, `scene_${i}_final.mp4`);
      let degraded = false;

      const isTemplate = scene?.visual_source === "template";
      const isStockVideoUrl = !isTemplate && !!scene?.video_url;
      const isStockVideoInline = !isTemplate && !!scene?.video_base64;

      if (isTemplate) {
        if (!scene.template_name) throw new Error(`Scene ${i}: visual_source=template but no template_name`);
        // The alignment's per-character array IS the narration transcript —
        // reused here (not a new field) to give Rhubarb a --dialogFile for
        // better phoneme accuracy on cartoon scenes.
        const dialogText = Array.isArray(scene?.audio?.alignment?.characters)
          ? scene.audio.alignment.characters.join("")
          : null;
        // Templates render full-screen on their own dark background — no image composite.
        await buildTemplateScene(scene.template_name, scene.template_data, duration, audioPath, outPath, tmpDir, mood, null, dialogText);
      } else if (isStockVideoUrl || isStockVideoInline) {
        const stockVideoPath = path.join(tmpDir, `stock_${i}.mp4`);
        if (isStockVideoInline) {
          // VidGen engine: the asset collector already downloaded the clip
          // (Pexels/Pixabay video search) and sends it inline, same as it
          // does for images — the video is a stored artifact blob, not a
          // URL this service could reach on its own.
          await writeBase64(scene.video_base64, stockVideoPath);
        } else {
          await downloadFile(scene.video_url, stockVideoPath);
        }
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
        const animationSourceUrl = Array.isArray(imageUrls) && imageUrls.length ? imageUrls[0] : null;
        const animate = !degraded && FAL_VIDEO_ENABLED && FAL_KEY && Boolean(animationSourceUrl) && (i === 0 || i === emphasisIdx);
        if (!degraded && FAL_VIDEO_ENABLED && FAL_KEY && !animationSourceUrl && Array.isArray(imageBase64s) && imageBase64s.length && (i === 0 || i === emphasisIdx)) {
          console.log(`[ltx] scene ${i} uses inline image bytes; skipping URL-only image-to-video and keeping deterministic Ken Burns motion`);
        }
        let animated = false;
        if (animate) {
          try {
            const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
            await generateVideoFromImage(animationSourceUrl, clipPath);
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
    const explanationMode = scenes.some((scene) => scene?.template_name === "explanation");
    const assContent = buildAssFromAlignment(scenes, offsets, explanationMode ? "" : comment_hook, contentDuration);
    await fsp.writeFile(assPath, assContent);

    // ===== PHASE 4: Sound design + Audio mixing + Final composite =====
    const musicPath = pickMusicTrack(mood);
    const sfxDir = path.join(MOTION_ASSETS_DIR, "sfx");
    // tick/pop/resolve are new (PR "sound design depth"). Before them, the 5
    // authored cue types and 12 fallback entries all collapsed onto just
    // impact/whoosh with only the volume differing -- so a "tick", a "pop"
    // and a "resolve" were literally the same audio file at three gains,
    // which is a cue TABLE, not sound design. These are synthesized with
    // ffmpeg rather than sourced: deterministic, reproducible from the
    // documented recipe in tests/sfx-assets.test.js, and free of the
    // licensing questions that come with third-party audio in a monetised
    // commercial video.
    const sfxFiles = {
      whoosh: path.join(sfxDir, "whoosh.wav"),
      impact: path.join(sfxDir, "impact.wav"),
      riser: path.join(sfxDir, "riser.wav"),
      tick: path.join(sfxDir, "tick.wav"),
      pop: path.join(sfxDir, "pop.wav"),
      resolve: path.join(sfxDir, "resolve.wav"),
    };
    const sfxAvailable = Object.fromEntries(
      Object.entries(sfxFiles).map(([name, file]) => [name, fs.existsSync(file)]),
    );

    // Restrained operation-aware sound design. Authored transformation cues
    // punctuate visible changes, while spacing and a hard cap prevent every cut
    // from becoming noisy. The final payoff keeps its quiet riser and resolve.
    const sfxEvents = [];
    // Each authored cue now maps to its OWN sound rather than a shared
    // impact/whoosh at a different gain: a tick is a short high click, a pop
    // is a rounded mid blip, a resolve is a warm two-tone chime. The planner
    // has always been able to author these five distinct cues; until now the
    // distinction never survived into the audio a viewer actually hears.
    const cueMap = {
      "soft-hit": { type: "impact", volume: 0.10 },
      tick: { type: "tick", volume: 0.09 },
      whoosh: { type: "whoosh", volume: 0.11 },
      pop: { type: "pop", volume: 0.10 },
      resolve: { type: "resolve", volume: 0.13 },
    };
    const visualStateFallback = {
      hypothesis: { type: "whoosh", volume: 0.065 },
      contradiction: { type: "impact", volume: 0.11 },
      qualification: { type: "whoosh", volume: 0.075 },
      payoff: { type: "resolve", volume: 0.13 },
    };
    // Differentiated so the fallback path is not itself a two-sound table:
    // discrete/placement operations tick, aggregating ones pop, continuous
    // spatial ones whoosh, and the closing payoff resolves.
    const operationFallback = {
      stack: { type: "tick", volume: 0.07 },
      compress: { type: "whoosh", volume: 0.10 },
      group: { type: "pop", volume: 0.09 },
      sort: { type: "tick", volume: 0.08 },
      "scale-compare": { type: "impact", volume: 0.08 },
      timeline: { type: "tick", volume: 0.06 },
      counter: { type: "tick", volume: 0.06 },
      payoff: { type: "resolve", volume: 0.13 },
    };
    // Retention research on what actually keeps a short-form viewer watching
    // singles out sound design as the single biggest lever, specifically "a
    // whoosh/pop/click tied to every zoom or text reveal" -- not background
    // music alone. The previous cap (10 events, 1.8s minimum spacing) was
    // sized for a much shorter or less scene-dense episode: at 15-17 scenes
    // over 60-70s, it left roughly 60% of scenes with no cue attached to
    // their visual change at all. Raised to keep pace with a typical
    // explanation-heavy episode's scene count without producing a
    // continuous, fatiguing barrage of clicks.
    let lastCueTime = -10;
    scenes.forEach((scene, index) => {
      if (scene?.template_name !== "explanation" || isOutroScene(scene)) return;
      const data = sceneTemplateData(scene);
      const selected = cueMap[data.soundCue] || operationFallback[data.visualOperation] || visualStateFallback[data.visualState];
      const operationPhase = data.visualOperation === "payoff"
        ? 0.74
        : ["compress", "group", "sort", "scale-compare"].includes(data.visualOperation)
          ? 0.68
          : 0.46;
      const sceneDuration = durations[index] || 1;
      const time = (offsets[index] || 0) + Math.min(Math.max(0.35, sceneDuration - 0.25), Math.max(0.35, sceneDuration * operationPhase));
      if (!selected || time - lastCueTime < 1.3 || sfxEvents.length >= 20) return;
      if (sfxAvailable[selected.type]) {
        sfxEvents.push({ ...selected, time });
        lastCueTime = time;
      }
    });
    const emphasisOffset = offsets[emphasisIdx];
    if (emphasisIdx >= 1 && emphasisOffset != null) {
      if (sfxAvailable.riser) sfxEvents.push({ type: "riser", time: Math.max(0, emphasisOffset - 1.3), volume: 0.14 });
      if (sfxAvailable.impact) sfxEvents.push({ type: "impact", time: emphasisOffset, volume: 0.17 });
    }

    // Cartoon mouth cues are rendered into each per-scene Remotion clip from
    // that scene's own narration audio. Rebuilding a separate gapless voice
    // track for the final mux changes scene-boundary timing and creates
    // cumulative lip-sync drift in the back half. For cartoon template
    // renders, preserve the concatenated scene audio ([0:a]) as the final
    // voice source instead, so mouth cues and audible speech share the same
    // boundaries throughout.
    const preserveSceneAudioForLipSync = scenes.some(
      (scene) => scene?.visual_source === "template" && ["cartoon", "explanation"].includes(scene?.template_name)
    );
    let voicePath = null;
    if (!preserveSceneAudioForLipSync) {
      // Gapless voiceover: rejoin the per-scene voice cleanly (no boundary
      // clicks) with a single loudnorm (consistent levels), used as the voice
      // track below instead of the concatenated video's gappy audio. Only
      // safe for renders with no lip-sync dependency on scene-audio timing.
      voicePath = path.join(tmpDir, "voice_full.m4a");
      await buildGaplessVoice(
        scenes.map((_, i) => path.join(tmpDir, `voice_${i}.mp3`)),
        voicePath
      );
    }

    // ===== PHASE 5: Final composite — video + captions + music + SFX =====
    const finalPath = path.join(tmpDir, "final.mp4");
    const outputFileName = `long_${jobId}.mp4`;
    const outputFullPath = path.join(OUTPUT_DIR, outputFileName);
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });

    const hasMusic = fs.existsSync(musicPath);
    const hasAss = fs.existsSync(assPath);
    const safeAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

    const finalCmd = ffmpeg().input(concatPath);   // [0] = concatenated video with scene-timed audio
    if (!preserveSceneAudioForLipSync) {
      finalCmd.input(voicePath);                   // [1] = rebuilt gapless voiceover (non-cartoon paths only)
    }
    if (hasMusic) finalCmd.input(musicPath);
    sfxEvents.forEach((ev) => finalCmd.input(sfxFiles[ev.type]));

    // For cartoon lip sync, keep [0:a] (the concatenated scene audio) as the
    // voice source so mouth cues and audible speech share boundaries. Every
    // other render rebuilds a gapless [1:a] track as before.
    const voiceLabel = preserveSceneAudioForLipSync ? "0:a" : "1:a";
    // Track input indices ([0]=video always taken; [1]=voice only when rebuilt)
    let nextIdx = preserveSceneAudioForLipSync ? 1 : 2;
    const musicIdx = hasMusic ? nextIdx++ : null;
    const sfxIndices = sfxEvents.map(() => nextIdx++);

    // Build video filter: ASS caption burn-in + fade in/out
    const fadeOutStart = Math.max(0, totalVideoDuration - 0.5);
    const videoFilter = hasAss
      ? `[0:v]ass=${safeAssPath},fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.5[final_v]`
      : `[0:v]fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.5[final_v]`;

    // Build audio filter: voice (gapless [1:a], or scene-timed [0:a] for
    // cartoon lip sync) + ducked music
    const audioFilters = [];
    const mixLabels = [voiceLabel];

    if (hasMusic) {
      // Explanation renders use a quieter bed so speech and transformation cues
      // stay in front; legacy formats preserve their established balance.
      const musicVolume = explanationMode ? 0.11 : 0.15;
      audioFilters.push(`[${musicIdx}:a]aloop=loop=-1:size=2e9,volume=${musicVolume}[music]`);
      audioFilters.push(`[music][${voiceLabel}]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=200[duckedmusic]`);
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
      "-map", mixLabels.length > 1 ? "[final_a]" : voiceLabel,
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
        const thumbnailResult = await buildThumbnail(reqBody.thumbnail.image_url, reqBody.thumbnail.text, reqBody.thumbnail.accent, tmpDir, thumbFull, reqBody.thumbnail.image_base64, reqBody.thumbnail.emphasis);
        thumbnailPath = thumbnailResult.path;
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
    if (!DEBUG_KEEP_TMP) {
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
    const { image_url = null, image_base64 = null, text = null, accent = null, emphasis = null } =
      req.body || {};

    const thumbnailResult = await buildThumbnail(image_url, text, accent, tmpDir, outPath, image_base64, emphasis);

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
      background: thumbnailResult.background,
      layout: thumbnailResult.layout,
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
