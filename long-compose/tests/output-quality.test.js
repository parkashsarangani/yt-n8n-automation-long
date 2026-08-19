/**
 * Cartoon production integration tests.
 *
 * The channel is cartoon-only. These tests intentionally cover the production
 * path we ship: 16:9 Remotion puppet scenes, concurrent scene rendering,
 * caption/alignment hardening, outro normalization, thumbnail compositing and
 * async job lifecycle. Stock/documentary template quality tests were removed.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");
const http = require("node:http");

const COMPOSE_PORT = 4111;
const BASE_URL = `http://127.0.0.1:${COMPOSE_PORT}`;
const TEST_TIMEOUT = 180_000;
const OUTPUT_DIR = path.join(__dirname, "_test_outputs");

let serverProcess;

function tempPath(ext) {
  return path.join(os.tmpdir(), `long-compose-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
}

function generateSilentAudioBase64(durationSec = 1.2) {
  const out = tempPath("mp3");
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-t", String(durationSec),
    "-c:a", "libmp3lame", "-b:a", "64k",
    out,
  ]);
  const base64 = fs.readFileSync(out).toString("base64");
  fs.rmSync(out, { force: true });
  return base64;
}

function generatePngBase64(color = "0x336699") {
  const out = tempPath("png");
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:d=0.1`,
    "-frames:v", "1",
    out,
  ]);
  const base64 = fs.readFileSync(out).toString("base64");
  fs.rmSync(out, { force: true });
  return base64;
}

function alignmentFor(text, { malformed = false } = {}) {
  const chars = [...text];
  const starts = chars.map((_, i) => i * 0.035);
  const ends = chars.map((_, i) => i * 0.035 + 0.03);
  if (malformed) {
    // Mismatched arrays used to leak undefined/NaN timing into ASS generation.
    starts.pop();
    ends.push("not-a-number");
  }
  return {
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

function cartoonScene(index, audioBase64, opts = {}) {
  return {
    scene_index: index,
    visual_source: "template",
    template_name: "cartoon",
    template_data: {
      ...(opts.isOutro ? { is_outro: true } : {}),
      background: opts.background || { flat: opts.flat || "#24364B" },
      camera: opts.camera || { type: "static" },
      characters: opts.characters || [
        {
          characterId: "pilot",
          animationKey: `host-${index}`,
          x: 300,
          y: 330,
          scale: 1,
          isSpeaking: true,
          gazeX: 6,
        },
        {
          characterId: "pilot-2",
          animationKey: `buddy-${index}`,
          x: 1110,
          y: 330,
          scale: 1,
          isSpeaking: false,
          expression: "surprised",
          gazeX: -6,
        },
      ],
    },
    audio: {
      audio_base64: audioBase64,
      ...(opts.alignment ? { alignment: opts.alignment } : {}),
    },
  };
}

// Non-cartoon motion-graphics scene, still fully supported by compose.js's
// categoryMap (buildTemplateScene) - the manual-script/legacy graph still
// reaches these.
function legacyTemplateScene(index, audioBase64, templateName, templateData) {
  return {
    scene_index: index,
    visual_source: "template",
    template_name: templateName,
    template_data: templateData,
    audio: { audio_base64: audioBase64 },
  };
}

function payloadWithScenes(scenes) {
  return {
    hook: "Cartoon integration test",
    caption_style: "neutral",
    comment_hook: "WHAT WOULD YOU DO? {TEST} \\ SAFE",
    data: scenes,
  };
}

function requestJSON(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: bytes
        ? { "Content-Type": "application/json", "Content-Length": bytes.length }
        : undefined,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on("error", reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

const postJSON = (urlPath, body) => requestJSON("POST", urlPath, body);
const getJSON = (urlPath) => requestJSON("GET", urlPath);

async function pollJob(jobId, timeoutMs = TEST_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await getJSON(`/compose-status/${jobId}`);
    if (response.body?.status === "done") return response.body;
    if (response.body?.status === "failed") {
      throw new Error(`Job failed: ${response.body.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Job ${jobId} timed out`);
}

function ffprobeJSON(filePath) {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format", "-show_streams",
    filePath,
  ], { encoding: "utf8" }));
}

before(async () => {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  serverProcess = spawn("node", ["compose.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(COMPOSE_PORT),
      OUTPUT_DIR,
      DEBUG_KEEP_TMP: "false",
      COMPOSE_CONCURRENCY: "3",
      JOB_TTL_MS: "5000",
      JOB_SWEEP_INTERVAL_MS: "1000",
      // No real external video generation should occur in integration tests.
      FAL_VIDEO_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`compose server did not start: ${stderr}`)), 15_000);
    serverProcess.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProcess.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`compose server exited during startup (${code}): ${stderr}`));
    });
  });
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await fsp.rm(OUTPUT_DIR, { recursive: true, force: true });
});

describe("cartoon render contract", { timeout: TEST_TIMEOUT }, () => {
  it("renders a multi-character cartoon as 1920x1080 H.264 with audio", async () => {
    const audio = generateSilentAudioBase64(1.2);
    const payload = payloadWithScenes([
      cartoonScene(0, audio, {
        background: { location: "bedroom", variant: "night", tone: "scary" },
        camera: { type: "pan", panFrom: 0, panTo: -60 },
        alignment: alignmentFor("hello world", { malformed: true }),
      }),
    ]);

    const start = await postJSON("/compose", payload);
    assert.equal(start.status, 202);
    assert.ok(start.body.job_id);

    const result = await pollJob(start.body.job_id);
    assert.ok(fs.existsSync(result.output_path));

    const probe = ffprobeJSON(result.output_path);
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audioStream = probe.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.width, 1920);
    assert.equal(video.height, 1080);
    assert.equal(video.codec_name, "h264");
    assert.equal(audioStream.codec_name, "aac");
  });

  it("renders several cartoon scenes concurrently without temp-file collisions", { timeout: TEST_TIMEOUT }, async () => {
    const audio = generateSilentAudioBase64(0.8);
    const scenes = Array.from({ length: 3 }, (_, i) => cartoonScene(i, audio, {
      flat: i % 2 ? "#503B67" : "#24495C",
      camera: { type: "pan", panFrom: -30, panTo: 30 },
    }));

    const start = await postJSON("/compose", payloadWithScenes(scenes));
    const result = await pollJob(start.body.job_id);
    assert.ok(fs.existsSync(result.output_path));
    assert.equal(result.degraded_scenes, 0);
  });
});

describe("legacy motion-graphics templates still render", { timeout: TEST_TIMEOUT }, () => {
  // The cartoon-first production graph never emits these, but graphs/manual.json
  // (still live) and any historical artifact can, and buildTemplateScene's
  // categoryMap still supports all seven - this is the coverage that was lost
  // when the suite was rewritten cartoon-only.
  const CATEGORIES = {
    timeline: { events: [{ year: "1947", title: "Independence" }], title: "Timeline" },
    ranking: { items: [{ name: "China", value: "1.4B" }], title: "Largest" },
    chart: { items: [{ label: "A", value: 80 }], title: "Chart" },
    list: { items: ["Key fact"], title: "Key Facts" },
    counter: { value: "3.5x", label: "MORE VIEWS" },
    comparison: { leftLabel: "BEFORE", leftValue: "$100", rightLabel: "AFTER", rightValue: "$10,000" },
    text: { text: "This changes everything" },
  };

  for (const [templateName, templateData] of Object.entries(CATEGORIES)) {
    it(`renders the "${templateName}" template`, async () => {
      const audio = generateSilentAudioBase64(0.6);
      const start = await postJSON("/compose", payloadWithScenes([
        legacyTemplateScene(0, audio, templateName, templateData),
      ]));
      assert.equal(start.status, 202);
      const result = await pollJob(start.body.job_id);
      assert.ok(fs.existsSync(result.output_path));
    });
  }
});

describe("compose rejects malformed jobs before rendering", { timeout: 20_000 }, () => {
  it("rejects an empty scenes array", async () => {
    const start = await postJSON("/compose", payloadWithScenes([]));
    assert.equal(start.status, 202);
    await assert.rejects(pollJob(start.body.job_id, 10_000), /No scenes provided/);
  });

  it("rejects a scene with no audio", async () => {
    const start = await postJSON("/compose", payloadWithScenes([
      { scene_index: 0, visual_source: "template", template_name: "text", template_data: { text: "no audio" }, audio: {} },
    ]));
    assert.equal(start.status, 202);
    await assert.rejects(pollJob(start.body.job_id, 10_000), /missing audio/);
  });

  it("fails a job rather than silently rendering an unknown template name", async () => {
    const audio = generateSilentAudioBase64(0.4);
    const start = await postJSON("/compose", payloadWithScenes([
      legacyTemplateScene(0, audio, "definitely_not_a_real_template", {}),
    ]));
    assert.equal(start.status, 202);
    await assert.rejects(pollJob(start.body.job_id, TEST_TIMEOUT));
  });
});

describe("outro and job lifecycle", { timeout: 30_000 }, () => {
  it("normalizes a single misplaced outro instead of assuming it is already last", async () => {
    const audio = generateSilentAudioBase64(0.5);
    const start = await postJSON("/compose", payloadWithScenes([
      cartoonScene(0, audio, { isOutro: true, flat: "#111827" }),
      cartoonScene(1, audio, { flat: "#1F5F55" }),
    ]));
    const result = await pollJob(start.body.job_id, TEST_TIMEOUT);
    assert.ok(fs.existsSync(result.output_path));
  });

  it("rejects multiple outro scenes before rendering", async () => {
    const audio = generateSilentAudioBase64(0.4);
    const start = await postJSON("/compose", payloadWithScenes([
      cartoonScene(0, audio, { isOutro: true }),
      cartoonScene(1, audio, { isOutro: true }),
    ]));
    assert.equal(start.status, 202);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = await getJSON(`/compose-status/${start.body.job_id}`);
      if (status.body?.status === "failed") {
        assert.match(status.body.error, /at most one outro/i);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("duplicate outro job did not fail");
  });

  it("expires abandoned terminal jobs", async () => {
    const start = await postJSON("/compose", { data: [] });
    assert.equal(start.status, 202);

    // Do not poll the terminal result: abandoned jobs should be swept.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const status = await getJSON(`/compose-status/${start.body.job_id}`);
    assert.equal(status.status, 404);
    assert.equal(status.body.status, "not_found");
  });
});

describe("thumbnail compositor", { timeout: 60_000 }, () => {
  it("renders 1280x720 cartoon artwork with deterministic typography metadata", async () => {
    const image = generatePngBase64("0x245A78");
    const response = await postJSON("/thumbnail", {
      image_base64: image,
      text: "DON'T OPEN IT",
      emphasis: "OPEN",
      accent: "#FFC712",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.width, 1280);
    assert.equal(response.body.height, 720);
    assert.equal(response.body.background, "supplied");
    assert.ok(response.body.image_base64.length > 1000);
    assert.ok(["left", "right"].includes(response.body.layout.side));
    assert.ok(response.body.layout.lines >= 1 && response.body.layout.lines <= 3);
    assert.ok(response.body.layout.headline_px >= 45);
    assert.equal(response.body.layout.overflow_px, 0);
  });

  it("keeps thumbnail metadata request-local under concurrency", async () => {
    const image = generatePngBase64("0x6D416D");
    const requests = [
      postJSON("/thumbnail", { image_base64: image, text: "THIS CHANGED", emphasis: "CHANGED", accent: "#FFC712" }),
      postJSON("/thumbnail", { text: "NO IMAGE", emphasis: "IMAGE", accent: "#FFC712" }),
      postJSON("/thumbnail", { image_base64: image, text: "LOOK HERE", emphasis: "LOOK", accent: "#FFC712" }),
      postJSON("/thumbnail", { text: "WHY NOW", emphasis: "WHY", accent: "#FFC712" }),
    ];

    const results = await Promise.all(requests);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
    assert.deepEqual(
      results.map((r) => r.body.background),
      ["supplied", "gradient", "supplied", "gradient"],
    );
    for (const result of results) assert.ok(result.body.layout);
  });
});
