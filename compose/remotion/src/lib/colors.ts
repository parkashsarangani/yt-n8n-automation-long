/**
 * Studio color palette per mood.
 * Split-tone system: warm highlights + cool shadows for cinematic depth.
 */

export type Mood = "upbeat" | "serious" | "funny" | "neutral";

export interface ColorScheme {
    background: string;
    backgroundGradient: string;
    primary: string;
    secondary: string;
    accent: string;
    textPrimary: string;
    textSecondary: string;
    shadow: string;
    glow: string;
}

const schemes: Record<Mood, ColorScheme> = {
    upbeat: {
        background: "#0f0f14",
        backgroundGradient: "radial-gradient(ellipse at 50% 30%, #1a1a2e 0%, #0f0f14 70%)",
        primary: "#fbbf24",
        secondary: "#f59e0b",
        accent: "#ef4444",
        textPrimary: "#ffffff",
        textSecondary: "#9ca3cd",
        shadow: "rgba(251, 191, 36, 0.3)",
        glow: "rgba(251, 191, 36, 0.15)",
    },
    serious: {
        background: "#0a0a0f",
        backgroundGradient: "radial-gradient(ellipse at 50% 30%, #141428 0%, #0a0a0f 70%)",
        primary: "#60a5fa",
        secondary: "#3b82f6",
        accent: "#a78bfa",
        textPrimary: "#f0f0f5",
        textSecondary: "#7882a4",
        shadow: "rgba(96, 165, 250, 0.25)",
        glow: "rgba(96, 165, 250, 0.1)",
    },
    funny: {
        background: "#0f0f14",
        backgroundGradient: "radial-gradient(ellipse at 50% 30%, #1e1a2e 0%, #0f0f14 70%)",
        primary: "#34d399",
        secondary: "#10b981",
        accent: "#fbbf24",
        textPrimary: "#ffffff",
        textSecondary: "#a3b8cd",
        shadow: "rgba(52, 211, 153, 0.3)",
        glow: "rgba(52, 211, 153, 0.12)",
    },
    neutral: {
        background: "#0f0f14",
        backgroundGradient: "radial-gradient(ellipse at 50% 30%, #1a1a24 0%, #0f0f14 70%)",
        primary: "#e2e8f0",
        secondary: "#94a3b8",
        accent: "#fbbf24",
        textPrimary: "#ffffff",
        textSecondary: "#94a3b8",
        shadow: "rgba(226, 232, 240, 0.2)",
        glow: "rgba(226, 232, 240, 0.08)",
    },
};

export function getScheme(mood: Mood): ColorScheme {
    return schemes[mood] || schemes.neutral;
}
