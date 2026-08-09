/**
 * Output Quality & Correctness Tests
 * -------------------------------------------------------------------
 * Validates that the compose pipeline produces videos meeting
 * studio-grade quality standards. Requires ffmpeg + ffprobe on PATH.
 *
 * Run: npm test
 * -------------------------------------------------------------------
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { execSync, spawn } = require("child_process");
const http = require("http");

const COMPOSE_PORT = 4111; // Use a non-conflicting port for tests
const BASE_URL = `http://localhost:${COMPOSE_PORT}`;
const TEST_TIMEOUT = 120_000; // 2 min per test (renders take time)

let serverProcess;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function generateSilentAudioBase64(durationSec = 3) {
    // Generate a short silent MP3 via ffmpeg, return as base64
    const tmpPath = path.join(__dirname, `_test_audio_${Date.now()}.mp3`);
    execSync(
        `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${durationSec} -c:a libmp3lame -b:a 64k "${tmpPath}"`,
        { stdio: "pipe" }
    );
    const base64 = fs.readFileSync(tmpPath).toString("base64");
    fs.unlinkSync(tmpPath);
    return base64;
}

function buildTestPayload(opts = {}) {
    const audioBase64 = generateSilentAudioBase64(opts.audioDuration || 3);

    // Minimal alignment data for caption testing
    const alignment = {
        characters: "H e l l o   w o r l d".split(""),
        character_start_times_seconds: [
            0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0,
        ],
        character_end_times_seconds: [
            0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1,
        ],
    };

    return {
        hook: "Test hook",
        caption_style: opts.mood || "neutral",
        comment_hook: "Would you try this?",
        data: [
            {
                scene_index: 0,
                visual_source: "template",
                template_name: opts.templateName || "kinetic_text",
                template_data: opts.templateData || { line: "Hello World" },
                audio: { audio_base64: audioBase64, alignment },
            },
            ...(opts.extraScenes || []),
        ],
    };
}

function postJSON(urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            `${BASE_URL}${urlPath}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            },
            (res) => {
                let chunks = "";
                res.on("data", (c) => (chunks += c));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(chunks) });
                    } catch {
                        resolve({ status: res.statusCode, body: chunks });
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

function getJSON(urlPath) {
    return new Promise((resolve, reject) => {
        http
            .get(`${BASE_URL}${urlPath}`, (res) => {
                let chunks = "";
                res.on("data", (c) => (chunks += c));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(chunks) });
                    } catch {
                        resolve({ status: res.statusCode, body: chunks });
                    }
                });
            })
            .on("error", reject);
    });
}

async function pollJobUntilDone(jobId, timeoutMs = TEST_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { body } = await getJSON(`/compose-status/${jobId}`);
        if (body.status === "done") return body;
        if (body.status === "failed") throw new Error(`Job failed: ${body.error}`);
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

function ffprobeJSON(filePath) {
    const raw = execSync(
        `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
        { encoding: "utf8" }
    );
    return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

before(async () => {
    // Start the compose server on test port
    serverProcess = spawn("node", ["compose.js"], {
        cwd: path.join(__dirname, ".."),
        env: {
            ...process.env,
            PORT: String(COMPOSE_PORT),
            OUTPUT_DIR: path.join(__dirname, "_test_outputs"),
            DEBUG_KEEP_TMP: "false",
        },
        stdio: "pipe",
    });

    await fsp.mkdir(path.join(__dirname, "_test_outputs"), { recursive: true });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Server failed to start within 10s")),
            10000
        );
        serverProcess.stdout.on("data", (chunk) => {
            if (chunk.toString().includes("listening on")) {
                clearTimeout(timeout);
                resolve();
            }
        });
        serverProcess.stderr.on("data", (chunk) => {
            console.error("[server]", chunk.toString());
        });
    });
});

after(async () => {
    if (serverProcess) {
        serverProcess.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
    }
    // Cleanup test outputs
    await fsp.rm(path.join(__dirname, "_test_outputs"), {
        recursive: true,
        force: true,
    });
});

// ---------------------------------------------------------------------------
// Tests: API correctness
// ---------------------------------------------------------------------------

describe("API endpoints", () => {
    it("POST /compose returns 202 with job_id", async () => {
        const payload = buildTestPayload();
        const { status, body } = await postJSON("/compose", payload);
        assert.strictEqual(status, 202);
        assert.ok(body.job_id, "Response should contain job_id");
        assert.strictEqual(body.status, "processing");
    });

    it("GET /compose-status/:id returns 404 for unknown job", async () => {
        const { status, body } = await getJSON("/compose-status/nonexistent-id");
        assert.strictEqual(status, 404);
        assert.strictEqual(body.status, "not_found");
    });

    it("GET /topic-history returns topics array", async () => {
        const { status, body } = await getJSON("/topic-history");
        assert.strictEqual(status, 200);
        assert.ok(Array.isArray(body.topics));
    });

    it("POST /topic-history stores a topic", async () => {
        const { status, body } = await postJSON("/topic-history", {
            topic: "Test topic",
            hook: "Test hook",
        });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, true);
    });
});

// ---------------------------------------------------------------------------
// Tests: Output video quality validation
// ---------------------------------------------------------------------------

describe("Video output quality", { timeout: TEST_TIMEOUT }, () => {
    let outputPath;
    let probeData;

    before(async () => {
        const payload = buildTestPayload({ audioDuration: 3, mood: "upbeat" });
        const { body } = await postJSON("/compose", payload);
        const result = await pollJobUntilDone(body.job_id);
        outputPath = result.output_path;
        assert.ok(fs.existsSync(outputPath), `Output file should exist: ${outputPath}`);
        probeData = ffprobeJSON(outputPath);
    });

    it("output is a valid MP4 container", () => {
        assert.strictEqual(probeData.format.format_name, "mov,mp4,m4a,3gp,3g2,mj2");
    });

    it("video resolution is 1080x1920 (9:16 vertical)", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        assert.ok(videoStream, "Should have a video stream");
        assert.strictEqual(videoStream.width, 1080);
        assert.strictEqual(videoStream.height, 1920);
    });

    it("video codec is H.264", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        assert.strictEqual(videoStream.codec_name, "h264");
    });

    it("video uses high profile", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        assert.ok(
            videoStream.profile && videoStream.profile.toLowerCase().includes("high"),
            `Expected high profile, got: ${videoStream.profile}`
        );
    });

    it("frame rate is 30fps", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        const fps = eval(videoStream.r_frame_rate); // e.g. "30/1"
        assert.ok(fps >= 29.9 && fps <= 30.1, `Expected 30fps, got ${fps}`);
    });

    it("pixel format is yuv420p (maximum compatibility)", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        assert.strictEqual(videoStream.pix_fmt, "yuv420p");
    });

    it("color space is BT.709", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        // ffprobe reports color_space, color_primaries, color_transfer
        if (videoStream.color_space) {
            assert.strictEqual(videoStream.color_space, "bt709");
        }
        if (videoStream.color_primaries) {
            assert.strictEqual(videoStream.color_primaries, "bt709");
        }
    });

    it("audio codec is AAC", () => {
        const audioStream = probeData.streams.find((s) => s.codec_type === "audio");
        assert.ok(audioStream, "Should have an audio stream");
        assert.strictEqual(audioStream.codec_name, "aac");
    });

    it("audio sample rate is 44100 or 48000 Hz", () => {
        const audioStream = probeData.streams.find((s) => s.codec_type === "audio");
        const rate = parseInt(audioStream.sample_rate);
        assert.ok(
            rate === 44100 || rate === 48000,
            `Expected 44100 or 48000, got ${rate}`
        );
    });

    it("audio is stereo (2 channels)", () => {
        const audioStream = probeData.streams.find((s) => s.codec_type === "audio");
        assert.strictEqual(audioStream.channels, 2);
    });

    it("video duration is reasonable (2-10s for test audio)", () => {
        const duration = parseFloat(probeData.format.duration);
        assert.ok(duration >= 2, `Duration too short: ${duration}s`);
        assert.ok(duration <= 10, `Duration too long: ${duration}s`);
    });

    it("file size is reasonable (not bloated by bad encoding)", () => {
        const stats = fs.statSync(outputPath);
        const sizeMB = stats.size / (1024 * 1024);
        const duration = parseFloat(probeData.format.duration);
        const mbPerSecond = sizeMB / duration;
        // Studio quality at CRF 16 should be 0.5-4 MB/s for 1080x1920@30fps
        assert.ok(
            mbPerSecond < 5,
            `File too large: ${mbPerSecond.toFixed(2)} MB/s (possible encoding issue)`
        );
        assert.ok(
            mbPerSecond > 0.1,
            `File suspiciously small: ${mbPerSecond.toFixed(2)} MB/s`
        );
    });

    it("video bitrate indicates quality (CRF 16 target)", () => {
        const videoStream = probeData.streams.find((s) => s.codec_type === "video");
        if (videoStream.bit_rate) {
            const bitrateMbps = parseInt(videoStream.bit_rate) / 1_000_000;
            // CRF 16 at 1080x1920@30fps typically produces 3-12 Mbps
            assert.ok(
                bitrateMbps > 1,
                `Video bitrate too low: ${bitrateMbps.toFixed(2)} Mbps`
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: Template rendering
// ---------------------------------------------------------------------------

describe("Template scenes render correctly", { timeout: TEST_TIMEOUT }, () => {
    it("stat_reveal template produces valid output", async () => {
        const payload = buildTestPayload({
            templateName: "stat_reveal",
            templateData: { statValue: "99.7%", label: "ACCURACY" },
            mood: "serious",
        });
        const { body } = await postJSON("/compose", payload);
        const result = await pollJobUntilDone(body.job_id);
        assert.ok(fs.existsSync(result.output_path));

        const probe = ffprobeJSON(result.output_path);
        const video = probe.streams.find((s) => s.codec_type === "video");
        assert.strictEqual(video.width, 1080);
        assert.strictEqual(video.height, 1920);
    });

    it("comparison template produces valid output", async () => {
        const payload = buildTestPayload({
            templateName: "comparison",
            templateData: {
                leftLabel: "BEFORE",
                leftValue: "$100",
                rightLabel: "AFTER",
                rightValue: "$10,000",
            },
            mood: "upbeat",
        });
        const { body } = await postJSON("/compose", payload);
        const result = await pollJobUntilDone(body.job_id);
        assert.ok(fs.existsSync(result.output_path));

        const probe = ffprobeJSON(result.output_path);
        const video = probe.streams.find((s) => s.codec_type === "video");
        assert.strictEqual(video.width, 1080);
        assert.strictEqual(video.height, 1920);
    });

    it("kinetic_text template produces valid output", async () => {
        const payload = buildTestPayload({
            templateName: "kinetic_text",
            templateData: { line: "This changes everything" },
            mood: "funny",
        });
        const { body } = await postJSON("/compose", payload);
        const result = await pollJobUntilDone(body.job_id);
        assert.ok(fs.existsSync(result.output_path));

        const probe = ffprobeJSON(result.output_path);
        const video = probe.streams.find((s) => s.codec_type === "video");
        assert.strictEqual(video.width, 1080);
        assert.strictEqual(video.height, 1920);
    });
});

// ---------------------------------------------------------------------------
// Tests: Multi-scene with transitions
// ---------------------------------------------------------------------------

describe("Multi-scene composition", { timeout: TEST_TIMEOUT * 2 }, () => {
    it("2-scene video is a hard cut (duration == sum of scenes + outro)", async () => {
        const audioBase64 = generateSilentAudioBase64(3);
        const alignment = {
            characters: "T e s t".split(""),
            character_start_times_seconds: [0, 0.1, 0.2, 0.3],
            character_end_times_seconds: [0.1, 0.2, 0.3, 0.4],
        };

        const payload = {
            hook: "Multi-scene test",
            caption_style: "neutral",
            comment_hook: "Thoughts?",
            data: [
                {
                    scene_index: 0,
                    visual_source: "template",
                    template_name: "kinetic_text",
                    template_data: { line: "Scene one" },
                    audio: { audio_base64: audioBase64, alignment },
                },
                {
                    scene_index: 1,
                    visual_source: "template",
                    template_name: "stat_reveal",
                    template_data: { statValue: "42", label: "THE ANSWER" },
                    audio: { audio_base64: audioBase64, alignment },
                },
            ],
        };

        const { body } = await postJSON("/compose", payload);
        const result = await pollJobUntilDone(body.job_id, TEST_TIMEOUT * 2);
        assert.ok(fs.existsSync(result.output_path));

        const probe = ffprobeJSON(result.output_path);
        const duration = parseFloat(probe.format.duration);

        // Hard cuts (no crossfade): duration == sum of scene durations,
        // plus the fixed 2s follow/subscribe outro appended to every video.
        // 3s + 3s + 2s outro = 8s, with some tolerance for encoding rounding.
        assert.ok(
            duration > 7.0,
            `Duration ${duration}s is too short — outro or a scene may be missing`
        );
        assert.ok(
            duration < 9.0,
            `Duration ${duration}s is too long for 2x3s scenes + 2s outro`
        );
    });
});

// ---------------------------------------------------------------------------
// Tests: Color grading validation
// ---------------------------------------------------------------------------

describe("Color grading", { timeout: TEST_TIMEOUT }, () => {
    it("all mood values produce valid output without errors", async () => {
        const moods = ["upbeat", "serious", "funny", "neutral"];

        for (const mood of moods) {
            const payload = buildTestPayload({
                templateName: "kinetic_text",
                templateData: { line: `Mood ${mood}` },
                mood,
            });
            const { status, body } = await postJSON("/compose", payload);
            assert.strictEqual(status, 202, `Failed to start job for mood: ${mood}`);

            const result = await pollJobUntilDone(body.job_id);
            assert.ok(
                fs.existsSync(result.output_path),
                `No output for mood: ${mood}`
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
    it("rejects empty scenes array", async () => {
        const { body } = await postJSON("/compose", {
            hook: "test",
            caption_style: "neutral",
            data: [],
        });
        // Should still return 202 (async), but the job should fail
        if (body.job_id) {
            await new Promise((r) => setTimeout(r, 2000));
            const { body: status } = await getJSON(`/compose-status/${body.job_id}`);
            assert.strictEqual(status.status, "failed");
        }
    });

    it("rejects scene without audio", async () => {
        const payload = {
            hook: "test",
            caption_style: "neutral",
            data: [
                {
                    scene_index: 0,
                    visual_source: "template",
                    template_name: "kinetic_text",
                    template_data: { line: "No audio" },
                },
            ],
        };
        const { body } = await postJSON("/compose", payload);
        if (body.job_id) {
            await new Promise((r) => setTimeout(r, 2000));
            const { body: status } = await getJSON(`/compose-status/${body.job_id}`);
            assert.strictEqual(status.status, "failed");
            assert.ok(status.error.includes("audio"));
        }
    });

    it("rejects unknown template name", async () => {
        const audioBase64 = generateSilentAudioBase64(2);
        const payload = {
            hook: "test",
            caption_style: "neutral",
            data: [
                {
                    scene_index: 0,
                    visual_source: "template",
                    template_name: "nonexistent_template",
                    template_data: {},
                    audio: { audio_base64: audioBase64 },
                },
            ],
        };
        const { body } = await postJSON("/compose", payload);
        if (body.job_id) {
            await new Promise((r) => setTimeout(r, 5000));
            const { body: status } = await getJSON(`/compose-status/${body.job_id}`);
            assert.strictEqual(status.status, "failed");
            assert.ok(status.error.includes("nonexistent_template"));
        }
    });
});
