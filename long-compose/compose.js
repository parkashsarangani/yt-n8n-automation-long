const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const bundledFfmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { buildStage, buildTitleCard } = require("./conversation-stage");

const ffmpegPath = bundledFfmpegPath && fs.existsSync(bundledFfmpegPath) ? bundledFfmpegPath : "ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);
const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "200mb" }));

const OUTPUT_DIR = process.env.OUTPUT_DIR || "/outputs";
const TOPIC_HISTORY_PATH = process.env.TOPIC_HISTORY_PATH || path.join(__dirname, "topic_history.json");
const TOPIC_HISTORY_MAX = 90;
const JOB_TTL_MS = Math.max(60_000, Number(process.env.JOB_TTL_MS) || 2 * 60 * 60 * 1000);
const jobs = new Map();
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use("/outputs", express.static(OUTPUT_DIR));

function tmpDir() {
  const dir = path.join(os.tmpdir(), `audio-first-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function historyPathFor(niche) {
  const safe = String(niche || "default").replace(/[^a-z0-9_-]/gi, "") || "default";
  return path.join(path.dirname(TOPIC_HISTORY_PATH), `topic_history_${safe}.json`);
}

app.get("/health", (_req, res) => res.json({ ok: true, mode: "audio-first" }));

app.get("/topic-history", async (req, res) => {
  try {
    const file = historyPathFor(req.query.niche);
    if (!fs.existsSync(file)) return res.json({ topics: [] });
    return res.json({ topics: JSON.parse(await fsp.readFile(file, "utf8")) });
  } catch (err) {
    return res.status(500).json({ topics: [], error: err.message });
  }
});

app.post("/topic-history", async (req, res) => {
  try {
    const { topic, hook } = req.body || {};
    if (!topic) return res.status(400).json({ success: false, error: "topic is required" });
    const file = historyPathFor(req.query.niche);
    let topics = fs.existsSync(file) ? JSON.parse(await fsp.readFile(file, "utf8")) : [];
    topics.push({ topic, hook: hook || null, created_at: new Date().toISOString() });
    topics = topics.slice(-TOPIC_HISTORY_MAX);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(topics, null, 2));
    return res.json({ success: true, count: topics.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

function audioExtension(mediaType) {
  const value = String(mediaType || "").toLowerCase();
  if (value.includes("wav")) return ".wav";
  if (value.includes("ogg")) return ".ogg";
  if (value.includes("aac") || value.includes("mp4")) return ".m4a";
  return ".mp3";
}

async function probeDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => err ? reject(err) : resolve(Number(data.format.duration || 0)));
  });
}

function concatPath(file) {
  return file.replace(/'/g, "'\\''");
}

async function buildAudioFirstVideo(data, outputPath) {
  if (!Array.isArray(data) || data.length === 0) throw new Error("compose requires at least one audio scene");
  const ordered = [...data].sort((a, b) => Number(a.scene_index) - Number(b.scene_index));
  const seen = new Set();
  const dir = tmpDir();
  try {
    const wavs = [];
    const durations = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const scene = ordered[i];
      if (!Number.isInteger(scene.scene_index) || seen.has(scene.scene_index)) throw new Error("scene_index values must be unique integers");
      seen.add(scene.scene_index);
      const b64 = scene.audio && scene.audio.audio_base64;
      if (!b64) throw new Error(`scene ${scene.scene_index} is missing audio_base64`);
      const input = path.join(dir, `scene-${i}-input${audioExtension(scene.audio.media_type)}`);
      const wav = path.join(dir, `scene-${i}.wav`);
      await fsp.writeFile(input, Buffer.from(b64, "base64"));
      await execFileAsync(ffmpegPath, ["-y", "-i", input, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", wav]);
      wavs.push(wav);
      durations.push(await probeDuration(wav));
    }

    const list = path.join(dir, "audio-concat.txt");
    await fsp.writeFile(list, wavs.map((file) => `file '${concatPath(file)}'`).join("\n"));
    const programme = path.join(dir, "programme.wav");
    await execFileAsync(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", programme]);
    const duration = await probeDuration(programme);
    if (!(duration > 0)) throw new Error("concatenated narration has zero duration");

    const hasStage = ordered.some(scene => scene.narration?.trim());
    const stageFile = path.join(dir, "stage.ass");
    if (hasStage) await fsp.writeFile(stageFile, buildStage(ordered, durations));

    await execFileAsync(ffmpegPath, [
      "-y",
      "-f", "lavfi", "-i", "color=c=0x101217:s=1920x1080:r=30",
      "-i", programme,
      "-map", "0:v:0", "-map", "1:a:0",
      ...(hasStage ? ["-vf", `drawbox=x=160:y=300:w=1600:h=460:color=0x1f2532:t=fill,drawbox=x=160:y=300:w=8:h=460:color=0x7ac5ce:t=fill,ass='${escapeFilterPath(stageFile)}'`] : []),
      "-t", String(duration),
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "20",
      "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath,
    ]);
    return await probeDuration(outputPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

app.post("/compose", (req, res) => {
  const jobId = crypto.randomUUID();
  const outputName = `audio-first-${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);
  jobs.set(jobId, { status: "processing", createdAt: Date.now() });
  res.status(202).json({ job_id: jobId, status: "processing" });

  const started = Date.now();
  buildAudioFirstVideo(req.body && req.body.data, outputPath)
    .then((duration) => jobs.set(jobId, {
      status: "done",
      success: true,
      output_path: outputPath,
      duration_sec: duration,
      render_time_sec: (Date.now() - started) / 1000,
      finishedAt: Date.now(),
    }))
    .catch(async (err) => {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      jobs.set(jobId, { status: "failed", success: false, error: err.message, finishedAt: Date.now() });
      console.error(`[compose ${jobId}]`, err);
    });
});

app.get("/compose-status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "not_found", success: false, error: "unknown job" });
  return res.json(job);
});

function writeGradientPpm(file, width = 1280, height = 720) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tx = x / width;
      const ty = y / height;
      pixels[offset++] = Math.round(15 + 28 * tx);
      pixels[offset++] = Math.round(18 + 22 * ty);
      pixels[offset++] = Math.round(28 + 42 * tx);
    }
  }
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

function escapeFilterPath(value) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

app.post("/thumbnail", async (req, res) => {
  const dir = tmpDir();
  try {
    const text = String(req.body && req.body.text || "").trim().slice(0, 60);
    if (!text) return res.status(400).json({ success: false, error: "thumbnail text is required" });
    const assFile = path.join(dir, "title.ass");
    await fsp.writeFile(assFile, buildTitleCard(text));
    const output = path.join(dir, "thumbnail.png");
    const supplied = req.body && req.body.image_base64;
    let input;
    let background;
    if (supplied) {
      input = path.join(dir, "background.img");
      await fsp.writeFile(input, Buffer.from(supplied, "base64"));
      background = "supplied";
    } else {
      input = path.join(dir, "background.ppm");
      writeGradientPpm(input);
      background = "gradient";
    }
    // The bundled ffmpeg-static build ships without the drawtext filter; libass
    // is present, so the title is rendered from an ASS subtitle instead.
    const filter = `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.18:t=fill,ass='${escapeFilterPath(assFile)}'`;
    await execFileAsync(ffmpegPath, ["-y", "-i", input, "-vf", filter, "-frames:v", "1", output]);
    const bytes = await fsp.readFile(output);
    return res.json({ success: true, image_base64: bytes.toString("base64"), media_type: "image/png", width: 1280, height: 720, background });
  } catch (err) {
    console.error("thumbnail render failed", err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}, Math.min(JOB_TTL_MS, 5 * 60 * 1000)).unref?.();

const port = Number(process.env.PORT || 4000);
if (require.main === module) {
  app.listen(port, "0.0.0.0", () => console.log(`long-compose audio-first listening on :${port}`));
}

module.exports = { app, buildAudioFirstVideo, historyPathFor };
