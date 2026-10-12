/**
 * Automatic edit of a Short from its beat images (operator 2026-10-10: "can
 * we add good editing to the images and then render them into the video and
 * upload directly without the editor?").
 *
 * The cut is built from what every Short already has: the narration clips
 * (with ElevenLabs word timing) and one series-style image per beat in the
 * episode's Drive beats/ folder. What makes it an edit rather than a
 * slideshow:
 *   - a cut every ~2.6 s, cycling framings of the beat's image (wide push-in,
 *     close-up on the faces, slow pans, pull-out), never a still frame;
 *   - a hook shot that snaps in and settles over the first beat;
 *   - big word-by-word captions in the clean area above the scene, the word
 *     being spoken highlighted in the series mustard;
 *   - a proper ending: during the spoken CTA the last story image pulls
 *     out slowly and a "FOLLOW FOR MORE" badge pops in under the captions;
 *   - with the animator service (animator/, ANIMATOR_URL), the pictures come
 *     alive without the bodies moving (operator 2026-10-11): everyone blinks,
 *     and a character drawn speaking moves its mouth with the narration and
 *     gestures with a free hand. The camera then holds still per shot. A shot
 *     the animator cannot make falls back to the still picture.
 *
 * Polish (2026-10-11, operator: "implement the recommended order"):
 *   - a quick transition (slide, zoom) whenever the image changes, hard cuts
 *     between framings of the same image;
 *   - sound design (auto-edit-sound.ts): whooshes, pops, a hook hit, an
 *     optional ducked music bed, the mix normalised to -14 LUFS;
 *   - emphasis marks: a "?" or "!" with a ray burst pops into the scene's
 *     empty top corner on questions and strong lines;
 *   - caption styles (AUTO_EDIT_CAPTIONS=pop|bounce|classic): "pop" bounces
 *     the spoken word, "bounce" slides each chunk up, "classic" is v1.
 *
 * The cut lands in Drive as final-auto.mp4 and goes out through the same
 * validated daily release queue as the editor's cuts. Whether a run is
 * auto-edited is decided by AUTO_EDIT (off | ab | all); "ab" alternates runs
 * so the two can be compared on real retention before the editor is dropped.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ffmpegBinary } from "./ffmpeg-file.ts";
import { isClosingScene, LEGACY_MAX_BEAT_IMAGES, narrationWords, selectBeats, type BeatScene } from "./beat-images.ts";
import { mixArgs, pickMusic, type SfxCue } from "./auto-edit-sound.ts";

const run = promisify(execFile);

/** The auto cut's name in the episode folder: a "final*" video, so the release queue imports it. */
export const AUTO_CUT_FILE = "final-auto.mp4";
/** Told to the editor the moment a run is assigned to the automatic edit. */
export const AUTO_EDIT_NOTE_FILE = "AUTO-EDITED - no edit needed.txt";
/** Told to the editor when the automatic edit gave up on a run. */
export const AUTO_EDIT_FAILED_NOTE_FILE = "AUTO-EDIT FAILED - please edit this one.txt";

/** Run-log tag: who edits this Short -- transformation "auto" or "editor" (the A/B label). */
export const EDIT_SOURCE_NODE = "edit_source";
/** Run-log tag for each automatic render attempt. */
export const AUTO_EDIT_NODE = "auto_edit";

export type AutoEditMode = "off" | "ab" | "all";

export function autoEditMode(value = process.env["AUTO_EDIT"]): AutoEditMode {
  const v = value?.trim().toLowerCase();
  if (v === "ab" || v === "all") return v;
  if (v && !/^(off|0|false|no)$/.test(v)) console.warn(`[auto-edit] AUTO_EDIT="${value}" is not off|ab|all; treating it as off`);
  return "off";
}

export type CaptionStyle = "pop" | "bounce" | "classic";

/**
 * The polish switches, each turned off (or on) by env for a quick comparison.
 * `voiceSpeed`: the narration is sped up by this much in the cut, pitch kept
 * (operator 2026-10-12: "the overall pace is a bit slow"); every cut, caption
 * and mouth movement follows the faster voice.
 */
export interface AutoCutStyle { transitions: boolean; sfx: boolean; music: boolean; emphasis: boolean; captions: CaptionStyle; voiceSpeed: number }

/** Default narration speed-up in the auto cut, on top of ELEVENLABS_SPEED. */
export const VOICE_SPEED = 1.08;

export function autoCutStyle(env: Record<string, string | undefined> = process.env): AutoCutStyle {
  const on = (name: string) => !/^(off|0|false|no)$/i.test(env[name]?.trim() ?? "");
  const c = env["AUTO_EDIT_CAPTIONS"]?.trim().toLowerCase();
  const speed = Number(env["AUTO_EDIT_VOICE_SPEED"]?.trim() || VOICE_SPEED);
  return {
    transitions: on("AUTO_EDIT_TRANSITIONS"),
    sfx: on("AUTO_EDIT_SFX"),
    music: on("AUTO_EDIT_MUSIC"),
    // Off unless asked for: the operator found the "?" and "!" marks an overdo (2026-10-12).
    emphasis: /^(on|1|true|yes)$/i.test(env["AUTO_EDIT_EMPHASIS"]?.trim() ?? ""),
    captions: c === "bounce" || c === "classic" ? c : "pop",
    // atempo keeps speech natural only for small changes; outside 0.8-1.3 falls back to the default.
    voiceSpeed: Number.isFinite(speed) && speed >= 0.8 && speed <= 1.3 ? speed : VOICE_SPEED,
  };
}

export const FPS = 30;
export const FRAME = { width: 1080, height: 1920 } as const;
/** The beat image's scene square (beat-images.ts: 1080x1080 at y=840). */
const SOURCE_SCENE_Y = 840;
const SCENE_PX = 1080;
/**
 * Where the scene sits in the cut: higher than in the beat image, so its
 * bottom stays clear of the bottom fifth where the apps draw their buttons.
 */
export const SCENE_Y = 640;
/** Soft edge where the scene meets the plain background, top and bottom. */
const FADE_PX = 90;
/** Captions: centred in the clean area above the scene. */
export const CAPTION_Y = 340;
/** One cut roughly this often. */
export const SHOT_TARGET_SEC = 2.6;
const MAX_SHOTS_PER_SCENE = 4;

// ---------------------------------------------------------------- timing

export interface TimedWord { text: string; start: number; end: number }

/**
 * Word timings for one narration clip, from ElevenLabs character timing when
 * present, else spread over the clip in proportion to word length.
 */
export function clipWords(narration: string, durationSec: number, alignment?: unknown): TimedWord[] {
  const a = alignment as { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | undefined;
  const chars = Array.isArray(a?.characters) ? (a!.characters as unknown[]) : [];
  const starts = Array.isArray(a?.character_start_times_seconds) ? (a!.character_start_times_seconds as unknown[]) : [];
  const ends = Array.isArray(a?.character_end_times_seconds) ? (a!.character_end_times_seconds as unknown[]) : [];
  if (chars.length > 0 && chars.length === starts.length && chars.length === ends.length) {
    const words: TimedWord[] = [];
    let text = "", start = 0, end = 0;
    const flush = () => { if (text.trim()) words.push({ text: text.trim(), start, end }); text = ""; };
    chars.forEach((c, i) => {
      const ch = String(c);
      if (/\s/.test(ch)) { flush(); return; }
      const s = Number(starts[i]), e = Number(ends[i]);
      if (!text) start = Number.isFinite(s) ? s : end;
      text += ch;
      if (Number.isFinite(e)) end = e;
    });
    flush();
    if (words.length > 0) return words.map((w) => ({ ...w, start: clamp(w.start, 0, durationSec), end: clamp(Math.max(w.end, w.start + 0.05), 0, durationSec) }));
  }
  const tokens = narration.split(/\s+/).filter(Boolean);
  const weight = tokens.reduce((n, t) => n + t.length + 1, 0) || 1;
  let t = 0;
  return tokens.map((text) => {
    const d = (durationSec * (text.length + 1)) / weight;
    const w = { text, start: t, end: t + d };
    t += d;
    return w;
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------- shots

/** One framing of a beat image: zoom and focus point (0..1 of the scene) at the shot's start and end. */
export interface Framing { name: string; z0: number; z1: number; x0: number; y0: number; x1: number; y1: number; ease: "linear" | "out" }

export const FRAMINGS: Record<string, Framing> = {
  hook: { name: "hook", z0: 1.35, z1: 1.05, x0: 0.5, y0: 0.47, x1: 0.5, y1: 0.5, ease: "out" },
  wide: { name: "wide", z0: 1.0, z1: 1.07, x0: 0.5, y0: 0.55, x1: 0.5, y1: 0.5, ease: "linear" },
  // Heads sit high in the scene (its top quarter is empty by design), so a
  // close-up stays loose enough to keep them whole -- tested 2026-10-10:
  // 1.34-1.42 around y=0.42 cut the tops of heads off.
  close: { name: "close", z0: 1.22, z1: 1.28, x0: 0.5, y0: 0.47, x1: 0.5, y1: 0.46, ease: "linear" },
  panRight: { name: "panRight", z0: 1.16, z1: 1.18, x0: 0.42, y0: 0.5, x1: 0.58, y1: 0.49, ease: "linear" },
  pullOut: { name: "pullOut", z0: 1.28, z1: 1.1, x0: 0.5, y0: 0.47, x1: 0.5, y1: 0.5, ease: "linear" },
  panLeft: { name: "panLeft", z0: 1.18, z1: 1.16, x0: 0.58, y0: 0.49, x1: 0.42, y1: 0.5, ease: "linear" },
};
const CYCLE = [FRAMINGS["wide"]!, FRAMINGS["close"]!, FRAMINGS["panRight"]!, FRAMINGS["pullOut"]!, FRAMINGS["panLeft"]!];

export interface Segment { scene_index: number; start: number; duration: number; image: number; is_outro?: boolean }
export interface Shot { image: number; startFrame: number; frames: number; framing: Framing; scene_index: number }

/**
 * Cut every segment into shots of ~SHOT_TARGET_SEC. Boundaries are rounded
 * on the cumulative timeline, so the video never drifts from the narration.
 */
export function planShots(segments: Segment[]): Shot[] {
  const shots: Shot[] = [];
  segments.forEach((seg, k) => {
    const n = clamp(Math.round(seg.duration / SHOT_TARGET_SEC), 1, MAX_SHOTS_PER_SCENE);
    for (let j = 0; j < n; j++) {
      const a = Math.round((seg.start + (seg.duration * j) / n) * FPS);
      const b = Math.round((seg.start + (seg.duration * (j + 1)) / n) * FPS);
      if (b <= a) continue;
      const framing = k === 0 && j === 0 ? FRAMINGS["hook"]!
        : seg.is_outro ? FRAMINGS["pullOut"]!
        : CYCLE[(k * 2 + j) % CYCLE.length]!;
      shots.push({ image: seg.image, startFrame: a, frames: b - a, framing, scene_index: seg.scene_index });
    }
  });
  return shots;
}

/**
 * The timeline: each narration clip back to back, each scene on the image
 * of its beat. A beat without an image keeps the previous one, and so does
 * the closing line: the ending stays on the story's last image.
 */
export function buildSegments(scenes: BeatScene[], durations: Map<number, number>, imageOfScene: Map<number, number>): Segment[] {
  let t = 0, last = 0;
  return [...scenes].sort((a, b) => a.scene_index - b.scene_index).map((s) => {
    const duration = durations.get(s.scene_index) ?? 0;
    const outro = isClosingScene(s);
    const image = (outro ? undefined : imageOfScene.get(s.scene_index)) ?? last;
    last = image;
    const seg: Segment = { scene_index: s.scene_index, start: t, duration, image, ...(outro ? { is_outro: true } : {}) };
    t += duration;
    return seg;
  }).filter((s) => s.duration > 0);
}

/** beats.json from beat-images.ts: the narration words each image covers. */
export interface BeatsManifest {
  version: number;
  scenes: Array<{ scene_index: number; words: number }>;
  images: Array<{ file: string; scene_index: number; start_word: number; end_word: number }>;
}

/**
 * The timeline from beats.json: every image on screen exactly while its
 * words are spoken (word times from the narration's own timing); the
 * closing line stays on the last image. An image whose file is missing
 * leaves its time to the image before it.
 */
export function manifestSegments(
  manifest: BeatsManifest,
  scenes: BeatScene[],
  timing: Map<number, { start: number; duration: number; words: TimedWord[] }>,
  files: string[],
): Segment[] {
  // Global word index -> time, over the narrated scenes in manifest order.
  const wordTimes: number[] = [];
  let narratedEnd = 0;
  for (const m of manifest.scenes) {
    const t = timing.get(m.scene_index);
    if (!t) continue;
    const scene = scenes.find((s) => s.scene_index === m.scene_index);
    const count = m.words;
    // The voice's own word timing when it has the same words, else even spacing.
    const timed = !!scene && t.words.length === count && narrationWords(scene.narration).length === count;
    for (let k = 0; k < count; k++) wordTimes.push(t.start + (timed ? t.words[k]!.start : (t.duration * k) / count));
    narratedEnd = Math.max(narratedEnd, t.start + t.duration);
  }
  const fileIndex = new Map(files.map((f, i) => [f, i]));
  const segments: Segment[] = [];
  manifest.images.forEach((img, i) => {
    const image = fileIndex.get(img.file);
    if (image === undefined) return;
    const start = segments.length === 0 ? 0 : wordTimes[img.start_word] ?? narratedEnd;
    const next = manifest.images.slice(i + 1).find((x) => fileIndex.has(x.file));
    const end = next ? wordTimes[next.start_word] ?? narratedEnd : narratedEnd;
    if (end - start > 0.04) segments.push({ scene_index: img.scene_index, start, duration: end - start, image });
  });
  // The closing line(s): the ending, on the story's last image.
  const lastImage = segments.at(-1)?.image ?? 0;
  for (const s of [...scenes].sort((a, b) => a.scene_index - b.scene_index)) {
    const t = timing.get(s.scene_index);
    if (t && t.start >= narratedEnd - 0.001 && t.duration > 0) segments.push({ scene_index: s.scene_index, start: t.start, duration: t.duration, image: lastImage, is_outro: true });
  }
  return segments;
}

/**
 * Before beats.json (images made before 2026-10-11): one image per beat for
 * the first 10 beats, named NN-<slug>.png in selectBeats() order, so NN-1
 * indexes that list. Returns scene_index -> position in `files`.
 */
export function mapBeatImages(scenes: BeatScene[], files: string[]): Map<number, number> {
  const beats = selectBeats(scenes, LEGACY_MAX_BEAT_IMAGES);
  const out = new Map<number, number>();
  files.forEach((name, i) => {
    const m = /^(\d{2})-.*\.png$/i.exec(name.trim());
    const beat = m ? beats[Number(m[1]) - 1] : undefined;
    if (beat) out.set(beat.scene_index, i);
  });
  return out;
}

// ---------------------------------------------------------------- ffmpeg

function easeExpr(f: Framing, frames: number): string {
  const p = frames > 1 ? `(on/${frames - 1})` : "0";
  return f.ease === "out" ? `(1-pow(1-${p},3))` : p;
}

/** zoompan over the scene (pre-scaled to 2x so slow motion does not shimmer). */
export function zoompanFilter(f: Framing, frames: number): string {
  const e = easeExpr(f, frames);
  const z = `${f.z0}+(${+(f.z1 - f.z0).toFixed(4)})*${e}`;
  const fx = `(${f.x0}+(${+(f.x1 - f.x0).toFixed(4)})*${e})`;
  const fy = `(${f.y0}+(${+(f.y1 - f.y0).toFixed(4)})*${e})`;
  return `zoompan=z='${z}':x='max(0,min(iw-iw/zoom,${fx}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${fy}*ih-ih/zoom/2))':d=${frames}:s=${SCENE_PX}x${SCENE_PX}:fps=${FPS}`;
}

/**
 * One shot: the beat image's plain caption-area colour fills the frame, the
 * moving scene sits at SCENE_Y, and soft strips of that colour hide the
 * scene's top and bottom edges.
 */
export function shotArgs(image: string, shot: Shot, output: string, tailFrames = 0): string[] {
  // `tailFrames`: the motion carries on past the shot's end, for the
  // transition into the next image to blend over.
  const frames = shot.frames + tailFrames;
  const seconds = (frames / FPS + 0.5).toFixed(3);
  const ramp = (alpha: string) => `crop=${FRAME.width}:${FADE_PX}:0:0,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
  const filter = [
    `[0:v]split=3[s0][s1][s2]`,
    `[s0]crop=${FRAME.width}:600:0:0,scale=${FRAME.width}:${FRAME.height},setsar=1[bg]`,
    `[s1]${ramp(`255*(1-Y/${FADE_PX - 1})`)}[top]`,
    `[s2]${ramp(`255*Y/${FADE_PX - 1}`)}[bot]`,
    `[1:v]crop=${SCENE_PX}:${SCENE_PX}:0:${SOURCE_SCENE_Y},scale=${SCENE_PX * 2}:${SCENE_PX * 2}:flags=lanczos,${zoompanFilter(shot.framing, frames)},setsar=1[sc]`,
    `[bg][sc]overlay=0:${SCENE_Y}:eof_action=endall[v1]`,
    `[v1][top]overlay=0:${SCENE_Y}[v2]`,
    `[v2][bot]overlay=0:${SCENE_Y + SCENE_PX - FADE_PX},format=yuv420p[v]`,
  ].join(";");
  return [
    "-v", "error", "-y",
    "-loop", "1", "-framerate", String(FPS), "-t", seconds, "-i", image,
    "-i", image,
    "-filter_complex", filter, "-map", "[v]",
    "-frames:v", String(frames), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    output,
  ];
}

// ---------------------------------------------------------------- animation

/** One animated clip of a beat image's scene square, from the animator service. */
export interface AnimateRequest {
  /** The 1080x1080 scene square, PNG. */
  image: Uint8Array;
  frames: number;
  /** The shot's first frame on the Short's timeline: blinks stay continuous across shots. */
  startFrame: number;
  /** Mouth openness 0..1 per frame of the shot, from the narration's loudness. */
  envelope: number[];
  seed: number;
}
export type AnimateFn = (req: AnimateRequest) => Promise<Uint8Array>;

/**
 * Mouth openness per video frame (0..1) from a 16-bit PCM WAV: loudness per
 * frame, normalised to the 95th percentile, opening fast and closing a little
 * slower so it reads as syllables; quiet is closed.
 */
export function speechEnvelope(wav: Uint8Array, fps = FPS): number[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!);
  if (wav.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("speechEnvelope: not a WAV file");
  let channels = 1, rate = 48000, bits = 16, dataAt = -1, dataLen = 0;
  for (let o = 12; o + 8 <= wav.byteLength;) {
    const id = tag(o), len = view.getUint32(o + 4, true);
    if (id === "fmt ") { channels = view.getUint16(o + 10, true); rate = view.getUint32(o + 12, true); bits = view.getUint16(o + 22, true); }
    if (id === "data") { dataAt = o + 8; dataLen = Math.min(len, wav.byteLength - dataAt); break; }
    o += 8 + len + (len % 2);
  }
  if (dataAt < 0 || bits !== 16) throw new Error("speechEnvelope: expected 16-bit PCM data");
  const samples = Math.floor(dataLen / 2 / channels);
  const hop = Math.max(1, Math.round(rate / fps));
  const rms: number[] = [];
  for (let start = 0; start + hop <= samples; start += hop) {
    let sum = 0;
    for (let i = start; i < start + hop; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += view.getInt16(dataAt + (i * channels + c) * 2, true);
      v /= channels;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / hop));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  let env = 0;
  return rms.map((r) => {
    const v = r / p95;
    env = v > env ? v : env * 0.55 + v * 0.45;
    return Math.min(1, Math.max(0, (env - 0.12) / 0.7));
  });
}

/**
 * A shot of an animated picture: the clip (the scene square, already moving)
 * takes the shot's framing and holds it -- only 1.5% of drift, because what
 * moves is now the characters, not the camera.
 */
export function animatedShotArgs(image: string, clip: string, shot: Shot, output: string, tailFrames = 0): string[] {
  const frames = shot.frames + tailFrames;
  const f = shot.framing;
  const p = frames > 1 ? `(on/${frames - 1})` : "0";
  const z = `${f.z1}*(1+0.015*${p})`;
  const hold = `zoompan=z='${z}':x='max(0,min(iw-iw/zoom,${f.x1}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${f.y1}*ih-ih/zoom/2))':d=1:s=${SCENE_PX}x${SCENE_PX}:fps=${FPS}`;
  const seconds = (frames / FPS + 0.5).toFixed(3);
  const ramp = (alpha: string) => `crop=${FRAME.width}:${FADE_PX}:0:0,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
  const filter = [
    `[0:v]split=3[s0][s1][s2]`,
    `[s0]crop=${FRAME.width}:600:0:0,scale=${FRAME.width}:${FRAME.height},setsar=1[bg]`,
    `[s1]${ramp(`255*(1-Y/${FADE_PX - 1})`)}[top]`,
    `[s2]${ramp(`255*Y/${FADE_PX - 1}`)}[bot]`,
    `[1:v]setpts=PTS-STARTPTS,scale=${SCENE_PX * 2}:${SCENE_PX * 2}:flags=lanczos,${hold},setsar=1[sc]`,
    `[bg][sc]overlay=0:${SCENE_Y}:eof_action=endall[v1]`,
    `[v1][top]overlay=0:${SCENE_Y}[v2]`,
    `[v2][bot]overlay=0:${SCENE_Y + SCENE_PX - FADE_PX},format=yuv420p[v]`,
  ].join(";");
  return [
    "-v", "error", "-y",
    "-loop", "1", "-framerate", String(FPS), "-t", seconds, "-i", image,
    "-i", clip,
    "-filter_complex", filter, "-map", "[v]",
    "-frames:v", String(frames), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    output,
  ];
}

// ---------------------------------------------------------------- transitions

/** Image-change transition length: quick enough to read as a cut with energy. */
export const TRANSITION_FRAMES = 7;
/** Rotated so no two image changes in a row look the same. */
// Not "zoomin": it blows the whole frame up past the scene band and dips to
// dark grey before the next image (trial 2026-10-12).
export const TRANSITIONS = ["smoothleft", "smoothup", "smoothright", "slideleft", "smoothdown"] as const;

/** Consecutive shots of one image: hard cuts inside a run, a transition between runs. */
export interface Run { image: number; startFrame: number; frames: number; shots: number[] }

export function planRuns(shots: Shot[]): Run[] {
  const runs: Run[] = [];
  shots.forEach((s, i) => {
    const last = runs.at(-1);
    if (last && last.image === s.image) {
      last.frames += s.frames;
      last.shots.push(i);
    } else {
      runs.push({ image: s.image, startFrame: s.startFrame, frames: s.frames, shots: [i] });
    }
  });
  return runs;
}

/**
 * Join the runs with xfade. Every run but the last carries TRANSITION_FRAMES
 * of tail, and each transition starts exactly where the next image's words
 * start, so the timeline (and the captions) stay on the narration's frames.
 */
export function xfadeArgs(runFiles: string[], runs: Run[], output: string): string[] {
  const inputs = runFiles.flatMap((f) => ["-i", f]);
  const d = (TRANSITION_FRAMES / FPS).toFixed(4);
  const parts = runFiles.map((_, i) => `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p[r${i}]`);
  let prev = "[r0]";
  for (let k = 1; k < runFiles.length; k++) {
    const out = k === runFiles.length - 1 ? "[v]" : `[x${k}]`;
    const offset = (runs[k]!.startFrame / FPS).toFixed(4);
    parts.push(`${prev}[r${k}]xfade=transition=${TRANSITIONS[(k - 1) % TRANSITIONS.length]}:duration=${d}:offset=${offset}${out}`);
    prev = out;
  }
  return [
    "-v", "error", "-y", ...inputs,
    "-filter_complex", parts.join(";"), "-map", "[v]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS),
    output,
  ];
}

/** The scene square of a beat image (beat-images.ts: 1080x1080 at y=840), as PNG. */
export function sceneSquareArgs(image: string, output: string): string[] {
  return ["-v", "error", "-y", "-i", image, "-vf", `crop=${SCENE_PX}:${SCENE_PX}:0:${SOURCE_SCENE_Y}`, "-frames:v", "1", output];
}

/**
 * Narration: every clip sped up by `tempo` (pitch kept), padded/trimmed to
 * exactly its duration on the cut's timeline (already divided by `tempo`),
 * then joined.
 */
export function audioArgs(clips: Array<{ file: string; duration: number }>, output: string, tempo = 1): string[] {
  const inputs = clips.flatMap((c) => ["-i", c.file]);
  const speed = tempo !== 1 ? `atempo=${tempo},` : "";
  const parts = clips.map((c, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,${speed}apad,atrim=0:${c.duration.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`);
  const filter = `${parts.join(";")};${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[a]`;
  return ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[a]", "-c:a", "pcm_s16le", output];
}

export function finalArgs(video: string, audio: string, ass: string, output: string): string[] {
  // libass, with the bundled caption font (assets/fonts); DejaVu Sans Bold is the fallback.
  const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
  return [
    "-v", "error", "-y", "-i", video, "-i", audio,
    "-vf", `ass='${esc(ass)}':fontsdir='${esc(CAPTION_FONTS_DIR)}'`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", "-shortest", output,
  ];
}

// ---------------------------------------------------------------- captions

/**
 * Caption font (operator 2026-10-11: "change the caption font and font size
 * as well"): Montserrat ExtraBold, the heavy geometric face of most viral
 * Shorts captions, bundled under SIL OFL 1.1 in assets/fonts so the render
 * never depends on what the container has installed.
 */
export const CAPTION_FONT = "Montserrat ExtraBold";
export const CAPTION_SIZE = 122;
export const CAPTION_FONTS_DIR = fileURLToPath(new URL("../assets/fonts/", import.meta.url));

const HIGHLIGHT = "&H0030B6F2&"; // series mustard #F2B630, as ASS BGR
const WHITE = "&H00FFFFFF&";

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function captionText(word: string): string {
  return word.replace(/[{}\\]/g, "").toUpperCase();
}

/** Up to 3 words per caption, never across a sentence or clause break. */
export function chunkWords(words: TimedWord[]): TimedWord[][] {
  const chunks: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    cur.push(w);
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0);
    if (cur.length >= 3 || chars >= 15 || /[.,!?;:]["')\]]*$/.test(w.text)) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** The end badge shown while the spoken CTA plays. */
export const CTA_BADGE = "FOLLOW FOR MORE";
const NAVY = "&H003F3122&"; // series deep navy #22313F

// ---------------------------------------------------------------- emphasis

/** Words that make a line land: a "!" mark pops when one is spoken. */
const STRONG = /^(never|always|stop|secret|mistake|worst|best|truth|actually|nobody|everyone|wrong|lie|lies|danger|instantly|immediately|exactly|really|huge|biggest)$/i;
/** No two marks closer than this; more is clutter. */
export const EMPHASIS_GAP_SEC = 4;
const EMPHASIS_HOLD_SEC = 1.3;
/** The marks' row: below a two-line caption, above the scene's soft top edge. */
export const MARK_Y = SCENE_Y - 120;
/** The burst's outer radius: MARK_Y + this stays above the scene. */
export const MARK_RAY_OUTER = 116;

export interface EmphasisMark { kind: "question" | "exclaim"; start: number; end: number; x: number; y: number }

/**
 * Where a mark pops: on the last word of a question ("?"), and on an
 * exclamation or a strong word ("!"), never in the hook's first second or
 * during the ending, never closer than EMPHASIS_GAP_SEC to the last one.
 * Marks alternate sides in the plain band between the captions and the
 * scene, never on the scene itself (trial 2026-10-11: inside the scene's top
 * corners they landed on a head and a wall clock in older images).
 */
export function emphasisMarks(words: TimedWord[], opts: { endBefore?: number } = {}): EmphasisMark[] {
  const marks: EmphasisMark[] = [];
  const stop = opts.endBefore ?? Infinity;
  let lastAt = -Infinity;
  for (const w of words) {
    const bare = w.text.replace(/["'()\]\[.,;:]+$/g, "");
    const kind = /\?["')\]]*$/.test(w.text) ? "question"
      : /!["')\]]*$/.test(w.text) || STRONG.test(bare.replace(/[^a-z]/gi, "")) ? "exclaim"
      : undefined;
    if (!kind || w.start < 1 || w.start - lastAt < EMPHASIS_GAP_SEC) continue;
    const end = Math.min(w.start + EMPHASIS_HOLD_SEC, stop);
    if (end - w.start < 0.5) continue;
    const left = marks.length % 2 === 1;
    marks.push({ kind, start: w.start, end, x: left ? 150 : FRAME.width - 150, y: MARK_Y });
    lastAt = w.start;
  }
  return marks;
}

/** Eight rays around the mark (an ASS vector drawing, centred on 0,0). */
function rays(inner: number, outer: number, width: number, count = 8): string {
  const pt = (r: number, a: number) => `${Math.round(r * Math.cos(a))} ${Math.round(r * Math.sin(a))}`;
  const half = Math.atan2(width / 2, inner);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i * 2 * Math.PI) / count - Math.PI / 2;
    out.push(`m ${pt(inner, a - half)} l ${pt(outer, a - half * 0.6)} ${pt(outer, a + half * 0.6)} ${pt(inner, a + half)}`);
  }
  return out.join(" ");
}

function markEvents(m: EmphasisMark): string[] {
  const t0 = assTime(m.start), t1 = assTime(m.end);
  const glyph = m.kind === "question" ? "?" : "!";
  const tilt = m.x < FRAME.width / 2 ? -10 : 10;
  return [
    // The burst: rays spring out and fade in the first half second.
    `Dialogue: 2,${t0},${assTime(Math.min(m.end, m.start + 0.55))},Mark,,0,0,0,,{\\an7\\pos(${m.x},${m.y})\\bord0\\shad0\\1c${HIGHLIGHT}\\fscx50\\fscy50\\t(0,160,\\fscx100\\fscy100)\\t(220,550,\\alpha&HFF&)\\p1}${rays(86, MARK_RAY_OUTER, 15)}{\\p0}`,
    // The mark: pops past full size, settles, rocks gently, fades out.
    `Dialogue: 3,${t0},${t1},Mark,,0,0,0,,{\\an5\\pos(${m.x},${m.y})\\frz${tilt}\\fscx0\\fscy0\\t(0,140,\\fscx125\\fscy125)\\t(140,260,\\fscx100\\fscy100)\\t(260,${Math.round((m.end - m.start) * 1000)},\\frz${-tilt / 2})\\fad(0,180)}${glyph}`,
  ];
}

// ---------------------------------------------------------------- captions

/** Montserrat's space is narrow at caption size; a hard space after it keeps words apart. */
const WORD_GAP = " \\h";

/** The chunk's words with the spoken one marked, in the caption style's look. */
function chunkLine(chunk: TimedWord[], spoken: number, style: CaptionStyle): string {
  return chunk.map((x, xi) => {
    const t = captionText(x.text);
    if (xi !== spoken) return t;
    if (style === "pop") return `{\\c${HIGHLIGHT}\\fscx100\\fscy100\\t(0,70,\\fscx118\\fscy118)\\t(70,170,\\fscx108\\fscy108)}${t}{\\c${WHITE}\\fscx100\\fscy100}`;
    return `{\\c${HIGHLIGHT}}${t}{\\c${WHITE}}`;
  }).join(WORD_GAP);
}

/** How a chunk arrives on its first word. */
function chunkEntrance(style: CaptionStyle): { pos: string; tags: string } {
  const x = FRAME.width / 2;
  if (style === "bounce") return { pos: `\\move(${x},${CAPTION_Y + 46},${x},${CAPTION_Y},0,130)`, tags: "\\fad(70,0)" };
  if (style === "pop") return { pos: `\\pos(${x},${CAPTION_Y})`, tags: "\\fscx70\\fscy70\\t(0,90,\\fscx106\\fscy106)\\t(90,150,\\fscx100\\fscy100)" };
  return { pos: `\\pos(${x},${CAPTION_Y})`, tags: "\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)" };
}

/**
 * ASS captions: one event per spoken word showing its whole chunk, the
 * spoken word in mustard; each chunk pops in. A chunk stays up until the
 * next one (no flicker in short pauses), at most 0.6 s past its last word.
 * `ending` (the spoken CTA's time) adds the FOLLOW badge under the captions;
 * `marks` adds the emphasis marks; `style` picks the caption look.
 */
export function captionsAss(words: TimedWord[], opts: { font?: string; ending?: { start: number; end: number }; style?: CaptionStyle; marks?: EmphasisMark[] } = {}): string {
  const font = opts.font ?? CAPTION_FONT;
  const style = opts.style ?? "classic";
  const chunks = chunkWords(words);
  const events: string[] = [];
  chunks.forEach((chunk, ci) => {
    const nextStart = chunks[ci + 1]?.[0]?.start;
    const chunkEnd = Math.min(nextStart ?? Infinity, chunk.at(-1)!.end + 0.6);
    chunk.forEach((w, wi) => {
      const start = w.start;
      const end = wi + 1 < chunk.length ? chunk[wi + 1]!.start : chunkEnd;
      if (end - start < 0.02) return;
      const entrance = chunkEntrance(style);
      const head = wi === 0 ? `{${entrance.pos}${entrance.tags}}` : `{\\pos(${FRAME.width / 2},${CAPTION_Y})}`;
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${head}${chunkLine(chunk, wi, style)}`);
    });
  });
  for (const m of opts.marks ?? []) events.push(...markEvents(m));
  if (opts.ending && opts.ending.end - opts.ending.start > 0.2) {
    events.push(`Dialogue: 1,${assTime(opts.ending.start)},${assTime(opts.ending.end)},Badge,,0,0,0,,{\\pos(${FRAME.width / 2},${SCENE_Y - 90})\\fscx40\\fscy40\\t(0,180,\\fscx108\\fscy108)\\t(180,300,\\fscx100\\fscy100)}${CTA_BADGE}`);
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${FRAME.width}`,
    `PlayResY: ${FRAME.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${font},${CAPTION_SIZE},${WHITE},${WHITE},&H00000000&,&H64000000&,-1,0,0,0,100,100,0,0,1,9,5,5,60,60,0,1`,
    // An opaque mustard box (BorderStyle 3) with navy text.
    `Style: Badge,${font},74,${NAVY},${NAVY},${HIGHLIGHT},${HIGHLIGHT},-1,0,0,0,100,100,2,0,3,22,0,5,70,70,0,1`,
    // Emphasis marks: a big mustard glyph with a thick navy outline.
    `Style: Mark,${font},180,${HIGHLIGHT},${HIGHLIGHT},${NAVY},&H64000000&,-1,0,0,0,100,100,0,0,1,10,5,5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- render

export interface AutoCutClip { scene_index: number; duration_sec: number; audio: Uint8Array; alignment?: unknown }

export interface AutoCutInput {
  scenes: BeatScene[];
  clips: AutoCutClip[];
  /** Beat images as delivered (NN-slug.png, 1080x1920 with the caption area on top). */
  images: Array<{ name: string; bytes: Uint8Array }>;
  /** beats.json, when the images were planned over the narration's time. */
  manifest?: BeatsManifest;
}

export interface AutoCutResult { video: Uint8Array; duration_sec: number; shots: number; animated_shots: number }

/** Render the automatic cut. Throws naming the ffmpeg stage that failed. */
export async function renderAutoCut(
  input: AutoCutInput,
  opts: { ffmpeg?: string; log?: (m: string) => void; animate?: AnimateFn; style?: AutoCutStyle; musicDir?: string } = {},
): Promise<AutoCutResult> {
  const ffmpeg = opts.ffmpeg ?? ffmpegBinary();
  const style = opts.style ?? autoCutStyle();
  const images = [...input.images].sort((a, b) => a.name.localeCompare(b.name));
  if (images.length === 0) throw new Error("auto edit: no beat images to cut from");
  const clipBy = new Map(input.clips.map((c) => [c.scene_index, c]));
  const scenes = [...input.scenes].filter((s) => clipBy.has(s.scene_index)).sort((a, b) => a.scene_index - b.scene_index);
  if (scenes.length === 0) throw new Error("auto edit: no narration clips match the script");
  // The cut's timeline runs on the sped-up voice: every duration and word time divided by it.
  const tempo = style.voiceSpeed;
  const durations = new Map(scenes.map((s) => [s.scene_index, clipBy.get(s.scene_index)!.duration_sec / tempo]));
  // Each clip back to back, with its words timed.
  const timing = new Map<number, { start: number; duration: number; words: TimedWord[] }>();
  const words: TimedWord[] = [];
  let at = 0;
  for (const scene of scenes) {
    const clip = clipBy.get(scene.scene_index)!;
    if (!(clip.duration_sec > 0)) continue;
    const local = clipWords(scene.narration, clip.duration_sec, clip.alignment).map((w) => ({ text: w.text, start: w.start / tempo, end: w.end / tempo }));
    const duration = clip.duration_sec / tempo;
    timing.set(scene.scene_index, { start: at, duration, words: local });
    for (const w of local) words.push({ text: w.text, start: at + w.start, end: at + w.end });
    at += duration;
  }
  const total = at;
  const names = images.map((i) => i.name);
  const fromManifest = input.manifest?.images?.length ? manifestSegments(input.manifest, scenes, timing, names) : [];
  const segments = fromManifest.length ? fromManifest : buildSegments(scenes, durations, mapBeatImages(input.scenes, names));
  const shots = planShots(segments);

  const dir = await mkdtemp(path.join(tmpdir(), "auto-edit-"));
  const step = async (name: string, args: string[], timeoutMs: number) => {
    try {
      await run(ffmpeg, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`auto edit ${name} failed: ${(e.stderr || e.message || String(err)).trim().slice(-400)}`);
    }
  };
  try {
    const imageFiles = await Promise.all(images.map(async (img, i) => {
      const file = path.join(dir, `image-${i}.png`);
      await writeFile(file, img.bytes);
      return file;
    }));
    const narrated = scenes.filter((s) => timing.has(s.scene_index));
    const clipFiles = await Promise.all(narrated.map(async (scene, i) => {
      const file = path.join(dir, `clip-${i}.mp3`);
      await writeFile(file, clipBy.get(scene.scene_index)!.audio);
      return { file, duration: timing.get(scene.scene_index)!.duration };
    }));
    const narration = path.join(dir, "narration.wav");
    await step("narration", audioArgs(clipFiles, narration, tempo), 120_000);

    let envelope: number[] = [];
    const squares = new Map<number, Uint8Array>();
    if (opts.animate) {
      envelope = speechEnvelope(new Uint8Array(await readFile(narration)));
      for (const k of new Set(shots.map((s) => s.image))) {
        const sq = path.join(dir, `square-${k}.png`);
        await step("scene square", sceneSquareArgs(imageFiles[k]!, sq), 60_000);
        squares.set(k, new Uint8Array(await readFile(sq)));
      }
    }
    const runs = planRuns(shots);
    const transitions = style.transitions && runs.length > 1;
    // The last shot of every run but the final one carries the transition's tail.
    const tailOf = new Set(transitions ? runs.slice(0, -1).map((r) => r.shots.at(-1)!) : []);
    const shotFiles: string[] = [];
    let animated = 0, animateFailures = 0;
    for (const [i, shot] of shots.entries()) {
      const file = path.join(dir, `shot-${String(i).padStart(3, "0")}.mp4`);
      const tail = tailOf.has(i) ? TRANSITION_FRAMES : 0;
      let done = false;
      // Two failures in a row: the animator is down, the rest stay still.
      if (opts.animate && animateFailures < 2) {
        try {
          const clip = await opts.animate({
            image: squares.get(shot.image)!,
            frames: shot.frames + tail,
            startFrame: shot.startFrame,
            envelope: envelope.slice(shot.startFrame, shot.startFrame + shot.frames + tail),
            seed: [...images[shot.image]!.name].reduce((n, c) => n + c.charCodeAt(0), 0),
          });
          const clipFile = path.join(dir, `anim-${i}.mp4`);
          await writeFile(clipFile, clip);
          await step(`animated shot ${i + 1}/${shots.length}`, animatedShotArgs(imageFiles[shot.image]!, clipFile, shot, file, tail), 120_000);
          done = true;
          animated++;
          animateFailures = 0;
        } catch (err) {
          animateFailures++;
          opts.log?.(`[auto-edit] shot ${i + 1}: animation failed (${err instanceof Error ? err.message : String(err)}); using the still picture`);
        }
      }
      if (!done) await step(`shot ${i + 1}/${shots.length}`, shotArgs(imageFiles[shot.image]!, shot, file, tail), 120_000);
      shotFiles.push(file);
    }
    opts.log?.(`[auto-edit] ${shots.length} shots rendered${opts.animate ? `, ${animated} animated` : ""}`);
    const concat = async (name: string, files: string[], output: string) => {
      const list = path.join(dir, `${name}.txt`);
      await writeFile(list, files.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
      await step(`join ${name}`, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output], 120_000);
    };
    const video = path.join(dir, "video.mp4");
    if (transitions) {
      const runFiles: string[] = [];
      for (const [k, r] of runs.entries()) {
        const file = path.join(dir, `run-${String(k).padStart(3, "0")}.mp4`);
        await concat(`run-${k}`, r.shots.map((i) => shotFiles[i]!), file);
        runFiles.push(file);
      }
      await step("transitions", xfadeArgs(runFiles, runs, video), 600_000);
    } else {
      await concat("shots", shotFiles, video);
    }

    const outro = segments.filter((s) => s.is_outro);
    const ending = outro.length ? { start: outro[0]!.start, end: outro.at(-1)!.start + outro.at(-1)!.duration } : undefined;
    const marks = style.emphasis ? emphasisMarks(words, { endBefore: ending?.start ?? total }) : [];

    // Sound design: a whoosh into every new image, a hit under the hook, a
    // pop for every mark and for the FOLLOW badge; music when the library has any.
    const cues: SfxCue[] = style.sfx ? [
      { kind: "hit", at: 0 },
      ...runs.slice(1).map((r) => ({ kind: "whoosh" as const, at: r.startFrame / FPS - 0.12 })),
      ...marks.map((m) => ({ kind: "pop" as const, at: m.start })),
      ...(ending ? [{ kind: "pop" as const, at: ending.start }] : []),
    ] : [];
    const music = style.music ? await pickMusic(scenes.map((s) => s.narration).join(" ").slice(0, 400), opts.musicDir) : undefined;
    const audio = path.join(dir, "mix.wav");
    await step("mix", mixArgs({ narration, total, cues, ...(music ? { music } : {}), output: audio }), 300_000);
    opts.log?.(`[auto-edit] mix: ${cues.length} effects, ${marks.length} marks, music ${music ? path.basename(music) : "none"}, captions ${style.captions}${transitions ? `, ${runs.length - 1} transitions` : ""}`);

    const ass = path.join(dir, "captions.ass");
    await writeFile(ass, captionsAss(words, { style: style.captions, marks, ...(ending ? { ending } : {}) }));
    const out = path.join(dir, "final-auto.mp4");
    await step("captions + encode", finalArgs(video, audio, ass, out), 600_000);
    return { video: new Uint8Array(await readFile(out)), duration_sec: +total.toFixed(3), shots: shots.length, animated_shots: animated };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What the editor reads in an auto-edited episode's folder. */
export function autoEditNote(): string {
  return [
    "This Short is edited automatically -- please do not edit it.",
    "",
    `The system renders ${AUTO_CUT_FILE} from the beat images and the narration and publishes it through the normal daily queue.`,
    "Adding your own final cut to this folder as well would stop it from publishing (two final videos).",
    "",
    "We are comparing automatic and hand-edited Shorts on real viewer retention; your Shorts are the other half of that test.",
  ].join("\n");
}

export function autoEditFailedNote(reason: string): string {
  return [
    "The automatic edit could not make this Short -- please edit it as usual and upload final.mp4 here.",
    "",
    `Reason: ${reason}`,
    "",
    `You can delete "${AUTO_EDIT_NOTE_FILE}".`,
  ].join("\n");
}
