/**
 * Custom easing functions for studio-grade motion.
 * These go beyond linear/ease-in-out to create the "snap" feel
 * seen in professional motion graphics.
 */

/** Spring-like overshoot: fast attack, slight bounce, settle */
export function springEase(t: number): number {
    const c4 = (2 * Math.PI) / 3;
    return t === 0
        ? 0
        : t === 1
            ? 1
            : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/** Expo out: fast start, graceful deceleration */
export function expoOut(t: number): number {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** Back out: slight overshoot then settle (for scale animations) */
export function backOut(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Smooth step: smooth acceleration and deceleration */
export function smoothStep(t: number): number {
    return t * t * (3 - 2 * t);
}

/** Cubic bezier approximation for cinematic motion */
export function cinematicEase(t: number): number {
    // Approximates cubic-bezier(0.16, 1, 0.3, 1) - the "Apple" ease
    return 1 - Math.pow(1 - t, 4);
}

/** Stagger delay calculator for sequenced reveals */
export function staggerDelay(index: number, staggerMs: number = 80): number {
    return index * staggerMs;
}
