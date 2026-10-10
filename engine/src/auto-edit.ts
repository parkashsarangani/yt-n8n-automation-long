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
 *   - the closing line over the hook image again, so the Short loops.
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
import { promisify } from "node:util";
import { ffmpegBinary } from "./ffmpeg-file.ts";
import { selectBeats, type BeatScene } from "./beat-images.ts";

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
 * of its beat. A beat without an image keeps the previous one; the closing
 * line goes back to the hook image so the Short loops.
 */
export function buildSegments(scenes: BeatScene[], durations: Map<number, number>, imageOfScene: Map<number, number>): Segment[] {
  let t = 0, last = 0;
  const firstImage = Math.min(...[...imageOfScene.values()], Infinity);
  return [...scenes].sort((a, b) => a.scene_index - b.scene_index).map((s) => {
    const duration = durations.get(s.scene_index) ?? 0;
    let image = imageOfScene.get(s.scene_index);
    if (s.is_outro && Number.isFinite(firstImage)) image = firstImage;
    if (image === undefined) image = last;
    last = image;
    const seg: Segment = { scene_index: s.scene_index, start: t, duration, image, ...(s.is_outro ? { is_outro: true } : {}) };
    t += duration;
    return seg;
  }).filter((s) => s.duration > 0);
}

/**
 * Which beat image belongs to which scene: beat-images.ts names them
 * NN-<slug>.png in selectBeats() order, so NN-1 indexes that list. Returns
 * scene_index -> position in `files`.
 */
export function mapBeatImages(scenes: BeatScene[], files: string[]): Map<number, number> {
  const beats = selectBeats(scenes);
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
export function shotArgs(image: string, shot: Shot, output: string): string[] {
  const seconds = (shot.frames / FPS + 0.5).toFixed(3);
  const ramp = (alpha: string) => `crop=${FRAME.width}:${FADE_PX}:0:0,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
  const filter = [
    `[0:v]split=3[s0][s1][s2]`,
    `[s0]crop=${FRAME.width}:600:0:0,scale=${FRAME.width}:${FRAME.height},setsar=1[bg]`,
    `[s1]${ramp(`255*(1-Y/${FADE_PX - 1})`)}[top]`,
    `[s2]${ramp(`255*Y/${FADE_PX - 1}`)}[bot]`,
    `[1:v]crop=${SCENE_PX}:${SCENE_PX}:0:${SOURCE_SCENE_Y},scale=${SCENE_PX * 2}:${SCENE_PX * 2}:flags=lanczos,${zoompanFilter(shot.framing, shot.frames)},setsar=1[sc]`,
    `[bg][sc]overlay=0:${SCENE_Y}:eof_action=endall[v1]`,
    `[v1][top]overlay=0:${SCENE_Y}[v2]`,
    `[v2][bot]overlay=0:${SCENE_Y + SCENE_PX - FADE_PX},format=yuv420p[v]`,
  ].join(";");
  return [
    "-v", "error", "-y",
    "-loop", "1", "-framerate", String(FPS), "-t", seconds, "-i", image,
    "-i", image,
    "-filter_complex", filter, "-map", "[v]",
    "-frames:v", String(shot.frames), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    output,
  ];
}

/** Narration: every clip padded/trimmed to exactly its recorded duration, then joined. */
export function audioArgs(clips: Array<{ file: string; duration: number }>, output: string): string[] {
  const inputs = clips.flatMap((c) => ["-i", c.file]);
  const parts = clips.map((c, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${c.duration.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`);
  const filter = `${parts.join(";")};${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[a]`;
  return ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[a]", "-c:a", "pcm_s16le", output];
}

export function finalArgs(video: string, audio: string, ass: string, output: string): string[] {
  // libass; the font is the container's DejaVu Sans Bold.
  const assPath = ass.replace(/\\/g, "/").replace(/:/g, "\\:");
  return [
    "-v", "error", "-y", "-i", video, "-i", audio,
    "-vf", `ass='${assPath}'`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", "-shortest", output,
  ];
}

// ---------------------------------------------------------------- captions

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
    if (cur.length >= 3 || chars >= 16 || /[.,!?;:]["')\]]*$/.test(w.text)) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * ASS captions: one event per spoken word showing its whole chunk, the
 * spoken word in mustard; each chunk pops in. A chunk stays up until the
 * next one (no flicker in short pauses), at most 0.6 s past its last word.
 */
export function captionsAss(words: TimedWord[], opts: { font?: string } = {}): string {
  const font = opts.font ?? "DejaVu Sans";
  const chunks = chunkWords(words);
  const events: string[] = [];
  chunks.forEach((chunk, ci) => {
    const nextStart = chunks[ci + 1]?.[0]?.start;
    const chunkEnd = Math.min(nextStart ?? Infinity, chunk.at(-1)!.end + 0.6);
    chunk.forEach((w, wi) => {
      const start = w.start;
      const end = wi + 1 < chunk.length ? chunk[wi + 1]!.start : chunkEnd;
      if (end - start < 0.02) return;
      const pop = wi === 0 ? "{\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)}" : "";
      const text = chunk.map((x, xi) => xi === wi ? `{\\c${HIGHLIGHT}}${captionText(x.text)}{\\c${WHITE}}` : captionText(x.text)).join(" ");
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\pos(${FRAME.width / 2},${CAPTION_Y})}${pop}${text}`);
    });
  });
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
    `Style: Caption,${font},108,${WHITE},${WHITE},&H00000000&,&H64000000&,-1,0,0,0,100,100,0,0,1,8,4,5,70,70,0,1`,
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
}

export interface AutoCutResult { video: Uint8Array; duration_sec: number; shots: number }

/** Render the automatic cut. Throws naming the ffmpeg stage that failed. */
export async function renderAutoCut(input: AutoCutInput, opts: { ffmpeg?: string; log?: (m: string) => void } = {}): Promise<AutoCutResult> {
  const ffmpeg = opts.ffmpeg ?? ffmpegBinary();
  const images = [...input.images].sort((a, b) => a.name.localeCompare(b.name));
  if (images.length === 0) throw new Error("auto edit: no beat images to cut from");
  const clipBy = new Map(input.clips.map((c) => [c.scene_index, c]));
  const scenes = [...input.scenes].filter((s) => clipBy.has(s.scene_index)).sort((a, b) => a.scene_index - b.scene_index);
  if (scenes.length === 0) throw new Error("auto edit: no narration clips match the script");
  const durations = new Map(scenes.map((s) => [s.scene_index, clipBy.get(s.scene_index)!.duration_sec]));
  const segments = buildSegments(scenes, durations, mapBeatImages(input.scenes, images.map((i) => i.name)));
  const shots = planShots(segments);
  const total = segments.reduce((n, s) => n + s.duration, 0);

  const words: TimedWord[] = [];
  for (const seg of segments) {
    const scene = scenes.find((s) => s.scene_index === seg.scene_index)!;
    const clip = clipBy.get(seg.scene_index)!;
    for (const w of clipWords(scene.narration, seg.duration, clip.alignment)) words.push({ text: w.text, start: seg.start + w.start, end: seg.start + w.end });
  }

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
    const shotFiles: string[] = [];
    for (const [i, shot] of shots.entries()) {
      const file = path.join(dir, `shot-${String(i).padStart(3, "0")}.mp4`);
      await step(`shot ${i + 1}/${shots.length}`, shotArgs(imageFiles[shot.image]!, shot, file), 120_000);
      shotFiles.push(file);
    }
    opts.log?.(`[auto-edit] ${shots.length} shots rendered`);
    const list = path.join(dir, "shots.txt");
    await writeFile(list, shotFiles.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const video = path.join(dir, "video.mp4");
    await step("join", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video], 120_000);

    const clipFiles = await Promise.all(segments.map(async (seg, i) => {
      const file = path.join(dir, `clip-${i}.mp3`);
      await writeFile(file, clipBy.get(seg.scene_index)!.audio);
      return { file, duration: seg.duration };
    }));
    const audio = path.join(dir, "narration.wav");
    await step("narration", audioArgs(clipFiles, audio), 120_000);

    const ass = path.join(dir, "captions.ass");
    await writeFile(ass, captionsAss(words));
    const out = path.join(dir, "final-auto.mp4");
    await step("captions + encode", finalArgs(video, audio, ass, out), 600_000);
    return { video: new Uint8Array(await readFile(out)), duration_sec: +total.toFixed(3), shots: shots.length };
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
