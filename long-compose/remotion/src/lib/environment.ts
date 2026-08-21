/**
 * Environment lighting presets for cartoon backgrounds.
 * Separate from the SVG art itself - the same bedroom/night drawing can
 * read as "scary" or "neutral" depending on which of these is applied.
 *
 * Environment tone is lighting/color direction only. Character emotion must
 * never make the whole camera vibrate: panic belongs on the actor, while any
 * future screen shake should be an explicit short-lived camera event.
 */

export type EnvironmentTone = "neutral" | "scary" | "happy" | "dramatic" | "cold" | "warm";

export interface EnvironmentEffect {
    /** CSS color, overlaid across the whole frame. */
    tint: string;
    /** 0-1: strength of a dark radial vignette at the frame edges. */
    vignette: number;
    /** 0-1: opacity of a soft fog layer over the background. */
    fog: number;
}

const presets: Record<EnvironmentTone, EnvironmentEffect> = {
    neutral: { tint: "rgba(0,0,0,0)", vignette: 0, fog: 0 },
    scary: { tint: "rgba(20,20,60,0.20)", vignette: 0.30, fog: 0.07 },
    happy: { tint: "rgba(255,220,150,0.12)", vignette: 0, fog: 0 },
    dramatic: { tint: "rgba(180,20,20,0.12)", vignette: 0.20, fog: 0 },
    cold: { tint: "rgba(120,170,255,0.18)", vignette: 0.15, fog: 0.1 },
    warm: { tint: "rgba(255,170,90,0.15)", vignette: 0, fog: 0 },
};

export function getEnvironmentEffect(tone?: EnvironmentTone): EnvironmentEffect {
    return presets[tone ?? "neutral"];
}
