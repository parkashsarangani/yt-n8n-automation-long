/**
 * Rhubarb Lip Sync mouth-cue lookup.
 * Rhubarb emits cues as non-overlapping [start, end) windows over one of
 * nine viseme shapes (A-H, plus X for closed/neutral).
 */

export interface MouthCue {
    start: number;
    end: number;
    value: string;
}

/** Rhubarb's neutral/closed-mouth viseme - the default whenever no cue covers the given time. */
export const NEUTRAL_MOUTH = "X";

const VALID_MOUTHS = new Set(["A", "B", "C", "D", "E", "F", "G", "H", "X"]);

function validCue(cue: MouthCue | undefined): cue is MouthCue {
    return !!cue &&
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.end > cue.start &&
        VALID_MOUTHS.has(cue.value);
}

/**
 * Which mouth shape is active at `timeSec`, given a scene's Rhubarb mouthCues.
 *
 * Treat cue data as untrusted render input. A malformed/unknown cue used to be
 * returned directly and became part of `mouth/${value}.svg`, producing a 404 in
 * Chromium and a broken-looking face. Invalid values or timings now degrade to
 * the neutral mouth instead.
 */
export function mouthAtTime(cues: MouthCue[] | undefined, timeSec: number): string {
    if (!cues || cues.length === 0 || !Number.isFinite(timeSec) || timeSec < 0) {
        return NEUTRAL_MOUTH;
    }

    const cue = cues.find((candidate) =>
        validCue(candidate) && timeSec >= candidate.start && timeSec < candidate.end,
    );
    return validCue(cue) ? cue.value : NEUTRAL_MOUTH;
}
