const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const { app, buildAudioFirstVideo, historyPathFor } = require("../compose.js");

function silentWav(sampleRate = 24000, durationSec = 0.2) {
  const samples = Math.max(1, Math.round(sampleRate * durationSec));
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

function scene(sceneIndex, durationSec = 0.2) {
  return {
    scene_index: sceneIndex,
    audio: {
      audio_base64: silentWav(24000, durationSec).toString("base64"),
      media_type: "audio/wav",
    },
  };
}

test("audio-first compositor exports an express app", () => {
  assert.equal(typeof app, "function");
});

test("topic history is isolated and sanitized by niche", () => {
  assert.equal(path.basename(historyPathFor("History & Mystery")), "topic_history_HistoryMystery.json");
  assert.equal(path.basename(historyPathFor("../")), "topic_history_default.json");
});

test("audio-first render concatenates narration into a valid MP4 shell", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "audio-first-test-"));
  const output = path.join(dir, "out.mp4");
  try {
    const duration = await buildAudioFirstVideo([scene(1, 0.15), scene(0, 0.2)], output);
    const bytes = await fsp.readFile(output);
    assert.ok(duration > 0.25, `expected concatenated narration duration, got ${duration}`);
    assert.ok(bytes.length > 1024, "expected a non-empty encoded MP4");
    assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("audio-first render rejects an empty programme", async () => {
  await assert.rejects(() => buildAudioFirstVideo([], "/tmp/unused.mp4"), /at least one audio scene/);
});

test("audio-first render rejects invalid scene identity before encoding", async () => {
  await assert.rejects(
    () => buildAudioFirstVideo([{ ...scene(0), scene_index: 0.5 }], "/tmp/unused.mp4"),
    /scene_index values must be unique integers/,
  );
});
