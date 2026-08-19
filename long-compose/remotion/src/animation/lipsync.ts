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

/** Which mouth shape is active at `timeSec`, given a scene's Rhubarb mouthCues. */
export function mouthAtTime(cues: MouthCue[] | undefined, timeSec: number): string {
    if (!cues || cues.length === 0) return NEUTRAL_MOUTH;
    const cue = cues.find((c) => timeSec >= c.start && timeSec < c.end);
    return cue?.value ?? NEUTRAL_MOUTH;
}
