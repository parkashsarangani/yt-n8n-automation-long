/**
 * The Drive size check proves an upload finished. It cannot prove the file is
 * this episode.
 *
 * Both failure modes below produce a complete, well-formed 1920x1080 MP4 that
 * passes every check the editor-return pass previously ran, and publishing is
 * unattended and public, so either one reaches the channel with nobody
 * looking: a partial export, and a different episode dropped in the folder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEditorCutDuration,
  readMp4DurationSec,
  EDITOR_CUT_MIN_RATIO,
  EDITOR_CUT_MAX_RATIO,
} from "../src/media/mp4.ts";
import { box, concat, mvhd, mvhd64, tkhd, mp4_1080p, mp4_1080p_lasting } from "./mp4-fixture.ts";

test("reads the programme duration from both movie-header versions", () => {
  assert.equal(readMp4DurationSec(box("moov", mvhd(182.5))), 182.5);
  assert.equal(readMp4DurationSec(box("moov", mvhd64(182.5))), 182.5);
  // Timescales other than 1000 are common in real exports.
  assert.equal(readMp4DurationSec(box("moov", mvhd(30, 90000))), 30);
});

test("a cut close to the draft is accepted and reports its real duration", () => {
  // The editor trimmed 12 seconds of dead air. That is their job.
  const cut = mp4_1080p_lasting(168);
  assert.equal(assertEditorCutDuration(cut, 180), 168);
});

test("a partial export is rejected instead of published", () => {
  // 20 seconds of a three-minute episode: complete file, right dimensions.
  const fragment = mp4_1080p_lasting(20);
  assert.throws(
    () => assertEditorCutDuration(fragment, 180),
    /runs 20\.0s against a 180\.0s draft/,
  );
});

test("a much longer file -- a different episode -- is rejected", () => {
  assert.throws(() => assertEditorCutDuration(mp4_1080p_lasting(600), 180), /different episode/);
});

test("the accepted band is exactly the declared ratio, inclusive at the edges", () => {
  const expected = 180;
  const atMin = mp4_1080p_lasting(expected * EDITOR_CUT_MIN_RATIO);
  const atMax = mp4_1080p_lasting(expected * EDITOR_CUT_MAX_RATIO);
  assert.equal(assertEditorCutDuration(atMin, expected), expected * EDITOR_CUT_MIN_RATIO);
  assert.equal(assertEditorCutDuration(atMax, expected), expected * EDITOR_CUT_MAX_RATIO);

  const justUnder = mp4_1080p_lasting(expected * EDITOR_CUT_MIN_RATIO - 1);
  assert.throws(() => assertEditorCutDuration(justUnder, expected));
});

test("an unreadable duration is not treated as a short file", () => {
  // Some valid containers state no duration. Rejecting those would block
  // legitimate cuts to catch a rarer fault, so they pass and report null.
  assert.equal(readMp4DurationSec(mp4_1080p()), null);
  assert.equal(assertEditorCutDuration(mp4_1080p(), 180), null);
});

test("an unknown expected duration cannot reject anything", () => {
  // No draft duration recorded: there is nothing to compare against, so the
  // cut passes and only its own duration is reported.
  const cut = mp4_1080p_lasting(45);
  for (const expected of [undefined, null, 0, Number.NaN]) {
    assert.equal(assertEditorCutDuration(cut, expected), 45);
  }
});

test("a zero or absent duration in the header reads as unknown, never as zero", () => {
  // The distinction matters: zero would divide into a 0x ratio and reject
  // every cut, unknown lets it through.
  assert.equal(readMp4DurationSec(box("moov", mvhd(0))), null);
  const zeroTimescale = concat(box("moov", concat(mvhd(10, 0), box("trak", tkhd(1920, 1080)))));
  assert.equal(readMp4DurationSec(zeroTimescale), null);
});
