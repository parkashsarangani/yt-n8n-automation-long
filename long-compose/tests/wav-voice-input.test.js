const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const bundledFfmpegPath = require("ffmpeg-static");
const ffmpegPath = bundledFfmpegPath && fs.existsSync(bundledFfmpegPath) ? bundledFfmpegPath : "ffmpeg";

function wavBytes(sampleRate = 24000, samples = 2400) {
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

describe("WAV voice input", () => {
  it("is decoded by the same FFmpeg fallback used by long-compose", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wav-voice-"));
    const input = path.join(dir, "voice_0.wav");
    try {
      fs.writeFileSync(input, wavBytes());
      assert.doesNotThrow(() => {
        execFileSync(ffmpegPath, ["-v", "error", "-i", input, "-f", "null", "-"], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the renderer-side media type plumbing explicit", () => {
    const composeSource = fs.readFileSync(path.join(__dirname, "..", "compose.js"), "utf8");
    // long-compose itself lets FFmpeg sniff the inline bytes; it must not reject
    // WAV by checking an MP3 MIME string before FFmpeg gets the input.
    assert.doesNotMatch(composeSource, /audio\.media_type\s*!==\s*["']audio\/mpeg["']/);
    assert.doesNotMatch(composeSource, /unsupported audio media type/);
  });
});
