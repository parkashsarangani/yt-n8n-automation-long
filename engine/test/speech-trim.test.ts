import test from "node:test";
import assert from "node:assert/strict";

import { shiftSpeechAlignment, speechTrimWindow } from "../src/audio/speech-trim.ts";

test("speech trim keeps a short natural turn gap around aligned speech", () => {
  const alignment = {
    characters: ["H", "i"],
    character_start_times_seconds: [0.32, 0.41],
    character_end_times_seconds: [0.40, 1.80],
  };
  assert.deepEqual(speechTrimWindow(alignment), {
    start_sec: 0.26,
    end_sec: 1.9,
    duration_sec: 1.64,
  });
});

test("shifting alignment preserves non-timing fields and clamps timestamps at zero", () => {
  const alignment = {
    characters: ["O", "K"],
    character_start_times_seconds: [0.05, 0.30],
    character_end_times_seconds: [0.20, 0.55],
  };
  assert.deepEqual(shiftSpeechAlignment(alignment, 0.10), {
    characters: ["O", "K"],
    character_start_times_seconds: [0, 0.2],
    character_end_times_seconds: [0.1, 0.45],
  });
});

test("invalid or missing alignment does not invent a trim window", () => {
  assert.equal(speechTrimWindow(null), null);
  assert.equal(speechTrimWindow({}), null);
  assert.equal(speechTrimWindow({ character_start_times_seconds: [0.2], character_end_times_seconds: [0.1] }), null);
});
