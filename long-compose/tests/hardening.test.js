const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const composePath = path.join(__dirname, "..", "compose.js");
const source = fs.readFileSync(composePath, "utf8");

test("compose production geometry is 1920x1080 landscape", () => {
  assert.match(source, /const TARGET_W = 1920;/);
  assert.match(source, /const TARGET_H = 1080;/);
  assert.doesNotMatch(source, /const TARGET_W = 1080;\s*\nconst TARGET_H = 1920;/);
});

test("renderRemotion never uses an async Promise executor", () => {
  assert.doesNotMatch(source, /new Promise\(async\s*\(/);
  assert.match(source, /async function renderRemotion\(/);
  assert.match(source, /finally\s*\{\s*await fsp\.unlink\(propsFile\)\.catch/);
});

test("concurrent Remotion scene artifacts use UUID filenames", () => {
  assert.match(source, /`props_\$\{crypto\.randomUUID\(\)\}\.json`/);
  assert.match(source, /`remotion_\$\{compositionId\}_\$\{crypto\.randomUUID\(\)\}\.mp4`/);
});

test("thumbnail metadata is request-local", () => {
  assert.doesNotMatch(source, /_lastThumbnailBackground|_lastThumbnailLayout|lastThumbnailBackground\(|lastThumbnailLayout\(/);
  assert.match(source, /return \{ path: outPath, background: thumbnailBackground, layout \};/);
  assert.match(source, /background: thumbnailResult\.background/);
  assert.match(source, /layout: thumbnailResult\.layout/);
});

test("terminal compose jobs have bounded retention", () => {
  assert.match(source, /const JOB_TTL_MS =/);
  assert.match(source, /job\.status === "done" \|\| job\.status === "failed"/);
  assert.match(source, /jobStore\.delete\(id\)/);
  assert.match(source, /jobSweepTimer\.unref\?\.\(\)/);
});

test("DEBUG_KEEP_TMP parses false-like strings correctly", () => {
  assert.match(source, /const DEBUG_KEEP_TMP = \/\^\(1\|true\|yes\)\$\/i\.test/);
  assert.match(source, /if \(!DEBUG_KEEP_TMP\)/);
  assert.doesNotMatch(source, /if \(!process\.env\.DEBUG_KEEP_TMP\)/);
});

test("inline image bytes cannot enter the URL-only image-to-video call", () => {
  assert.match(source, /const animationSourceUrl = Array\.isArray\(imageUrls\)/);
  assert.match(source, /Boolean\(animationSourceUrl\)/);
  assert.match(source, /generateVideoFromImage\(animationSourceUrl, clipPath\)/);
  assert.doesNotMatch(source, /generateVideoFromImage\(imageUrls\[0\], clipPath\)/);
});

test("outro handling accepts object or encoded template data and normalizes final position", () => {
  assert.match(source, /function isOutroScene\(scene\)/);
  assert.match(source, /JSON\.parse\(data\)\?\.is_outro === true/);
  assert.match(source, /Expected at most one outro scene/);
  assert.match(source, /scenes\.splice\(outroIndex, 1\)/);
  assert.match(source, /scenes\.push\(outro\)/);
});

test("caption input is escaped and alignment arrays are validated before ASS generation", () => {
  assert.match(source, /function escapeAssText\(value\)/);
  assert.match(source, /function validatedAlignment\(alignment, sceneIdx\)/);
  assert.match(source, /escapeAssText\(word\.text\)/);
  assert.match(source, /escapeAssText\(commentHook\)/);
  assert.match(source, /const length = Math\.min\(chars\.length, starts\.length, ends\.length\)/);
});

test("template mux copies Remotion video unless padding is actually needed", () => {
  assert.match(source, /const needsPadding = templateDuration \+ 0\.05 < duration/);
  assert.match(source, /opts\.push\("-c:v", "copy", "-c:a", "aac"/);
  assert.match(source, /tpad=stop_mode=clone/);
});
