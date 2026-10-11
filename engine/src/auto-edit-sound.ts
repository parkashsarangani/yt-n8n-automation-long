/**
 * Sound design for the automatic Short edit (operator 2026-10-11: "implement
 * the recommended order"): the narration alone made the auto cut sound like
 * a voice memo. The mix adds
 *   - small sound effects, synthesised by ffmpeg itself (no sample library,
 *     nothing to license): a soft whoosh on every image change, a pop when an
 *     emphasis mark or the FOLLOW badge appears, a low hit under the hook;
 *   - a music bed from the operator's own library folder (AUTO_EDIT_MUSIC_DIR,
 *     default /data/music: CC0 or licensed tracks only), looped to length,
 *     faded, and ducked under the voice by a sidechain compressor; with an
 *     empty folder there is simply no music;
 *   - loudness normalisation of the whole mix to -14 LUFS / -1.5 dBTP, what
 *     YouTube, Reels and TikTok play back at, so the auto cut is never
 *     quieter (or clipping louder) than the Shorts around it.
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

export type SfxKind = "whoosh" | "pop" | "hit";

/** One sound effect on the cut's timeline (seconds). */
export interface SfxCue { kind: SfxKind; at: number }

/**
 * ffmpeg lavfi sources for the effects, each a few hundred milliseconds,
 * 48 kHz. Gains are set so they sit under the voice, not on top of it.
 */
export const SFX_SOURCES: Record<SfxKind, { lavfi: string; gain: number }> = {
  // Pink noise, band-limited, swelling in and falling away: an air swish.
  whoosh: {
    lavfi: "anoisesrc=color=pink:sample_rate=48000:amplitude=0.9:duration=0.42,highpass=f=500,lowpass=f=4200,afade=t=in:st=0:d=0.24:curve=qsin,afade=t=out:st=0.24:d=0.18:curve=exp",
    gain: 0.32,
  },
  // A short sine chirp falling from ~1.4 kHz with a fast decay: a bubble pop.
  pop: {
    lavfi: "aevalsrc=exprs='sin(2*PI*t*(380+1000*exp(-t*38)))*exp(-t*30)':sample_rate=48000:duration=0.16",
    gain: 0.45,
  },
  // A low sine thump: the hook's snap-in.
  hit: {
    lavfi: "aevalsrc=exprs='0.9*sin(2*PI*58*t)*exp(-t*9)+0.25*sin(2*PI*116*t)*exp(-t*14)':sample_rate=48000:duration=0.5",
    gain: 0.55,
  },
};

/** At most this many effects of a kind; more than that is noise, not design. */
const MAX_CUES = 40;

/** Cues in time order, inside the cut, never two of a kind within 0.25 s. */
export function normaliseCues(cues: SfxCue[], total: number): SfxCue[] {
  const out: SfxCue[] = [];
  for (const c of [...cues].sort((a, b) => a.at - b.at)) {
    const at = Math.max(0, c.at);
    if (at >= total - 0.05) continue;
    if (out.some((o) => o.kind === c.kind && Math.abs(o.at - at) < 0.25)) continue;
    if (out.filter((o) => o.kind === c.kind).length >= MAX_CUES) continue;
    out.push({ kind: c.kind, at: +at.toFixed(3) });
  }
  return out;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;

export function musicDir(value = process.env["AUTO_EDIT_MUSIC_DIR"]): string {
  return value?.trim() || "/data/music";
}

/**
 * The bed for this Short: one track from the library, the same one every
 * time the same Short is rendered (picked by a hash of `seed`), so a retry
 * does not change the cut. Undefined with no library.
 */
export async function pickMusic(seed: string, dir = musicDir()): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => AUDIO_EXT.test(n) && !n.startsWith(".")).sort();
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  const h = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return path.join(dir, names[h % names.length]!);
}

/** Bed level before ducking (linear): there under the pauses, never competing with the voice. */
export const MUSIC_GAIN = 0.18;
/** YouTube / Reels / TikTok playback loudness. */
export const TARGET_LUFS = -14;

/**
 * The final mix: the narration (already timed to the cut) + the effects +
 * the optional music bed ducked under the voice, normalised to TARGET_LUFS.
 * Writes 48 kHz stereo PCM to `output`.
 */
export function mixArgs(opts: { narration: string; total: number; cues: SfxCue[]; music?: string; output: string }): string[] {
  const total = opts.total.toFixed(3);
  const cues = normaliseCues(opts.cues, opts.total);
  const inputs: string[] = ["-i", opts.narration];
  const parts: string[] = [`[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${total},asetpts=PTS-STARTPTS[voice]`];
  let next = 1;
  if (opts.music) {
    inputs.push("-stream_loop", "-1", "-i", opts.music);
    const fadeOut = Math.max(0, opts.total - 1.8).toFixed(3);
    parts.push(`[${next}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total},asetpts=PTS-STARTPTS,volume=${MUSIC_GAIN},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut}:d=1.8[bed]`);
    next++;
  }
  const fx: string[] = [];
  cues.forEach((c, i) => {
    const src = SFX_SOURCES[c.kind];
    inputs.push("-f", "lavfi", "-i", src.lavfi);
    const ms = Math.round(c.at * 1000);
    parts.push(`[${next}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${src.gain},adelay=${ms}|${ms}[fx${i}]`);
    fx.push(`[fx${i}]`);
    next++;
  });
  const layers: string[] = [];
  if (opts.music) {
    // The voice is heard and is also the key that ducks the bed.
    parts.push(`[voice]asplit=2[vmix][vkey]`);
    parts.push(`[bed][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[ducked]`);
    layers.push("[vmix]", "[ducked]");
  } else {
    layers.push("[voice]");
  }
  layers.push(...fx);
  parts.push(layers.length > 1
    ? `${layers.join("")}amix=inputs=${layers.length}:duration=first:dropout_transition=0:normalize=0[mix]`
    : `[voice]anull[mix]`);
  parts.push(`[mix]atrim=0:${total},loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[a]`);
  return ["-v", "error", "-y", ...inputs, "-filter_complex", parts.join(";"), "-map", "[a]", "-c:a", "pcm_s16le", "-ar", "48000", opts.output];
}
