/**
 * Environment lighting presets for cartoon backgrounds.
 * Separate from the SVG art itself - the same bedroom/night drawing can
 * read as "scary" or "neutral" depending on which of these is applied.
 */

export type EnvironmentTone = "neutral" | "scary" | "happy" | "dramatic" | "cold" | "warm";

export interface EnvironmentEffect {
    /** CSS color, overlaid across the whole frame. */
    tint: string;
    /** 0-1: strength of a dark radial vignette at the frame edges. */
    vignette: number;
    /** 0-1: opacity of a soft fog layer over the background. */
    fog: number;
    /** px: amplitude of a subtle camera jitter. 0 = no shake. */
    shake: number;
}

const presets: Record<EnvironmentTone, EnvironmentEffect> = {
    neutral: { tint: "rgba(0,0,0,0)", vignette: 0, fog: 0, shake: 0 },
    scary: { tint: "rgba(20,20,60,0.35)", vignette: 0.55, fog: 0.14, shake: 1.5 },
    happy: { tint: "rgba(255,220,150,0.12)", vignette: 0, fog: 0, shake: 0 },
    dramatic: { tint: "rgba(180,20,20,0.18)", vignette: 0.35, fog: 0, shake: 0.6 },
    cold: { tint: "rgba(120,170,255,0.18)", vignette: 0.15, fog: 0.1, shake: 0 },
    warm: { tint: "rgba(255,170,90,0.15)", vignette: 0, fog: 0, shake: 0 },
};

export function getEnvironmentEffect(tone?: EnvironmentTone): EnvironmentEffect {
    return presets[tone ?? "neutral"];
}
