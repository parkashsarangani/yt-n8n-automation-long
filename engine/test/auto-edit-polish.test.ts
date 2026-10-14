/**
 * Auto-edit polish (2026-10-11): transitions only where the image changes and
 * timed to the narration, sound effects and an optional ducked music bed in
 * a loudness-normalised mix, emphasis marks outside the scene, caption styles
 * and the bundled caption font.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CAPTION_FONT, CAPTION_FONTS_DIR, FPS, FRAME, FRAMINGS, MARK_RAY_OUTER, MARK_Y, SCENE_Y, TRANSITION_FRAMES,
  VOICE_SPEED, audioArgs, autoCutStyle, captionsAss, emphasisMarks, finalArgs, planRuns, shotArgs, xfadeArgs, type Shot,
} from "../src/auto-edit.ts";
import { mixArgs, normaliseCues, pickMusic, TARGET_LUFS } from "../src/auto-edit-sound.ts";

const shot = (image: number, startFrame: number, frames: number): Shot => ({ image, startFrame, frames, framing: FRAMINGS["wide"]!, scene_index: 0 });

test("polish is on by default; each switch and the caption style come from env", () => {
  assert.deepEqual(autoCutStyle({}), { transitions: true, sfx: true, music: true, emphasis: false, captions: "pop", voiceSpeed: VOICE_SPEED });
  assert.equal(autoCutStyle({ AUTO_EDIT_EMPHASIS: "on" }).emphasis, true, "marks only when asked for");
  assert.equal(autoCutStyle({ AUTO_EDIT_VOICE_SPEED: "1.15" }).voiceSpeed, 1.15);
  assert.equal(autoCutStyle({ AUTO_EDIT_VOICE_SPEED: "2" }).voiceSpeed, VOICE_SPEED, "out of range: the default");
  const s = autoCutStyle({ AUTO_EDIT_TRANSITIONS: "off", AUTO_EDIT_SFX: "0", AUTO_EDIT_CAPTIONS: "Bounce" });
  assert.equal(s.transitions, false);
  assert.equal(s.sfx, false);
  assert.equal(s.captions, "bounce");
  assert.equal(autoCutStyle({ AUTO_EDIT_CAPTIONS: "comic sans" }).captions, "pop");
});

test("runs group shots of one image; transitions start exactly where the next image starts", () => {
  const shots = [shot(0, 0, 60), shot(0, 60, 75), shot(1, 135, 80), shot(2, 215, 50), shot(2, 265, 40)];
  const runs = planRuns(shots);
  assert.deepEqual(runs.map((r) => [r.image, r.startFrame, r.frames, r.shots]), [[0, 0, 135, [0, 1]], [1, 135, 80, [2]], [2, 215, 90, [3, 4]]]);
  const args = xfadeArgs(["a.mp4", "b.mp4", "c.mp4"], runs, "out.mp4");
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.match(graph, new RegExp(`\\[r0\\]\\[r1\\]xfade=transition=\\w+:duration=${(TRANSITION_FRAMES / FPS).toFixed(4)}:offset=${(135 / FPS).toFixed(4)}\\[x1\\]`));
  assert.match(graph, new RegExp(`\\[x1\\]\\[r2\\]xfade=transition=\\w+:duration=[\\d.]+:offset=${(215 / FPS).toFixed(4)}\\[v\\]`));
  const kinds = [...graph.matchAll(/transition=(\w+)/g)].map((m) => m[1]);
  assert.notEqual(kinds[0], kinds[1], "consecutive transitions differ");
});

test("a shot carrying a transition tail renders that many extra frames", () => {
  const plain = shotArgs("img.png", shot(0, 0, 60), "o.mp4");
  const tailed = shotArgs("img.png", shot(0, 0, 60), "o.mp4", TRANSITION_FRAMES);
  assert.equal(plain[plain.indexOf("-frames:v") + 1], "60");
  assert.equal(tailed[tailed.indexOf("-frames:v") + 1], String(60 + TRANSITION_FRAMES));
});

test("emphasis marks: questions and strong lines, spaced out, never in the hook's first second or the ending, outside the scene", () => {
  const w = (text: string, start: number) => ({ text, start, end: start + 0.3 });
  const words = [w("Why?", 0.4), w("You", 1.5), w("never", 2.0), w("say", 2.4), w("no?", 3.0), w("Stop!", 7.0), w("Really?", 11.7), w("Follow", 12.2)];
  const marks = emphasisMarks(words, { endBefore: 12 });
  assert.deepEqual(marks.map((m) => [m.kind, m.start]), [["exclaim", 2.0], ["exclaim", 7.0]], "the 0.4 s hook word, the too-close question and the one running into the ending are dropped");
  assert.notEqual(marks[0]!.x, marks[1]!.x, "marks alternate sides");
  for (const m of marks) {
    assert.equal(m.y, MARK_Y);
    assert.ok(m.y + MARK_RAY_OUTER <= SCENE_Y, "the mark's burst stays above the scene");
    assert.ok(m.x - MARK_RAY_OUTER >= 0 && m.x + MARK_RAY_OUTER <= FRAME.width, "and inside the frame");
  }
  const ass = captionsAss(words, { marks, style: "pop" });
  assert.equal(ass.split("\n").filter((l) => /^Dialogue: [23],.*Mark/.test(l)).length, marks.length * 2, "a burst and a glyph per mark");
  assert.match(ass, /\\p1\}m -?\d+ -?\d+ l /, "the burst is a vector drawing");
});

test("caption styles: pop bounces the spoken word, bounce slides the chunk up, classic is v1; Montserrat by default", () => {
  const words = [{ text: "you", start: 0, end: 0.3 }, { text: "again", start: 0.3, end: 0.7 }];
  const pop = captionsAss(words, { style: "pop" });
  assert.match(pop, /\\fscx118\\fscy118/);
  assert.match(pop, new RegExp(`Style: Caption,${CAPTION_FONT},`));
  assert.match(captionsAss(words, { style: "bounce" }), /\\move\(540,\d+,540,\d+,0,130\)/);
  assert.doesNotMatch(captionsAss(words, { style: "classic" }), /\\fscx118|\\move/);
});

test("the final encode loads the bundled font folder", () => {
  const args = finalArgs("v.mp4", "a.wav", "c.ass", "o.mp4");
  const vf = args[args.indexOf("-vf") + 1]!;
  assert.match(vf, /:fontsdir='/);
  assert.match(CAPTION_FONTS_DIR.replace(/\\/g, "/"), /assets\/fonts\/?$/);
});

test("sound cues are sorted, inside the cut, and never doubled", () => {
  const cues = normaliseCues([{ kind: "pop", at: 5 }, { kind: "whoosh", at: -0.1 }, { kind: "pop", at: 5.1 }, { kind: "hit", at: 0 }, { kind: "pop", at: 30 }], 10);
  assert.deepEqual(cues, [{ kind: "whoosh", at: 0 }, { kind: "hit", at: 0 }, { kind: "pop", at: 5 }]);
});

test("the mix: voice + effects, the bed ducked under the voice, normalised to -14 LUFS", () => {
  const plain = mixArgs({ narration: "n.wav", total: 10, cues: [], output: "o.wav" });
  const g0 = plain[plain.indexOf("-filter_complex") + 1]!;
  assert.doesNotMatch(g0, /sidechaincompress|amix/);
  assert.match(g0, new RegExp(`loudnorm=I=${TARGET_LUFS}:TP=-1\\.5`));

  const full = mixArgs({ narration: "n.wav", total: 10, cues: [{ kind: "whoosh", at: 2 }, { kind: "pop", at: 4.5 }], music: "bed.mp3", output: "o.wav" });
  const g = full[full.indexOf("-filter_complex") + 1]!;
  assert.match(g, /\[bed\]\[vkey\]sidechaincompress/, "the voice ducks the bed");
  assert.match(g, /amix=inputs=4:duration=first/, "voice, bed, two effects");
  assert.match(g, /adelay=2000\|2000/);
  assert.match(g, /adelay=4500\|4500/);
  assert.ok(full.includes("-stream_loop"), "the bed loops to the Short's length");
});

test("music: one track from the library, the same one for the same Short; none without a library", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "music-"));
  try {
    assert.equal(await pickMusic("a short", dir), undefined);
    for (const n of ["b.mp3", "a.wav", "notes.txt", ".hidden.mp3"]) await writeFile(path.join(dir, n), "x");
    const first = await pickMusic("a short", dir);
    assert.ok(first && /[ab]\.(mp3|wav)$/.test(first));
    assert.equal(await pickMusic("a short", dir), first);
    assert.equal(await pickMusic("x", path.join(dir, "missing")), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the narration is sped up with its pitch kept, each clip trimmed to its shortened length", () => {
  const args = audioArgs([{ file: "a.mp3", duration: 2 / 1.08 }, { file: "b.mp3", duration: 3 / 1.08 }], "n.wav", 1.08);
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.equal(graph.match(/atempo=1\.08,/g)?.length, 2);
  assert.match(graph, /atrim=0:1\.8519/);
  assert.doesNotMatch(audioArgs([{ file: "a.mp3", duration: 2 }], "n.wav")[6]!, /atempo/, "no tempo filter at normal speed");
});

test("the FOLLOW badge shows only while the spoken CTA plays -- never over the verdict before it", async () => {
  const { ctaBadgeWindow } = await import("../src/auto-edit.ts");
  const scenes = [
    { scene_index: 7, narration: "Fear doesn't have to leave. It just loses the deciding vote.", is_outro: true, point: "[outro] verdict" },
    { scene_index: 8, narration: "Follow Quiet Signal for more psychology and philosophy.", point: "[cta] Subscribe" },
  ];
  const segments = [
    { scene_index: 6, start: 0, duration: 50, image: 3 },
    { scene_index: 7, start: 50, duration: 4, image: 3, is_outro: true },
    { scene_index: 8, start: 54, duration: 3, image: 3, is_outro: true },
  ];
  assert.deepEqual(ctaBadgeWindow(segments, scenes), { start: 54, end: 57 }, "starts with the spoken CTA, not the verdict");
  assert.deepEqual(ctaBadgeWindow(segments.slice(0, 2), scenes.slice(0, 1)), { start: 50, end: 54 }, "no CTA scene: the last closing scene");
  assert.equal(ctaBadgeWindow(segments.slice(0, 1), []), undefined);
});
