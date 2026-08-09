import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { getScheme, Mood } from "../lib/colors";
import { backOut, cinematicEase } from "../lib/easing";

interface StatRevealProps {
    statValue: string;
    label: string;
    icon: string;
    mood: Mood;
}

export const StatReveal: React.FC<StatRevealProps> = ({
    statValue,
    label,
    mood,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const scheme = getScheme(mood);

    // Timing (in frames)
    const glowStart = 5;
    const iconStart = 8;
    const numberStart = 18;
    const labelStart = 28;
    const lineStart = 24;

    // Background glow pulse
    const glowOpacity = interpolate(
        frame,
        [glowStart, glowStart + 20, glowStart + 40],
        [0, 0.6, 0.35],
        { extrapolateRight: "clamp" }
    );

    // Icon entrance: scale from 0 with spring overshoot
    const iconProgress = interpolate(frame, [iconStart, iconStart + 18], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const iconScale = backOut(iconProgress);
    const iconOpacity = interpolate(frame, [iconStart, iconStart + 6], [0, 1], {
        extrapolateRight: "clamp",
    });

    // Stat number: counter reveal with scale punch
    const numberProgress = interpolate(frame, [numberStart, numberStart + 14], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const numberScale = interpolate(
        frame,
        [numberStart, numberStart + 8, numberStart + 14],
        [1.3, 0.95, 1.0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    const numberOpacity = cinematicEase(numberProgress);
    const numberY = interpolate(
        frame,
        [numberStart, numberStart + 14],
        [40, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }
    );

    // Label: fade up
    const labelProgress = interpolate(frame, [labelStart, labelStart + 12], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const labelOpacity = cinematicEase(labelProgress);
    const labelY = interpolate(frame, [labelStart, labelStart + 12], [20, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });

    // Decorative line
    const lineWidth = interpolate(frame, [lineStart, lineStart + 20], [0, 400], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });

    // Subtle floating animation for the icon
    const iconFloat = Math.sin((frame / fps) * 2 * Math.PI * 0.5) * 4;

    return (
        <AbsoluteFill
            style={{
                background: scheme.backgroundGradient,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
            }}
        >
            {/* Radial glow behind content */}
            <div
                style={{
                    position: "absolute",
                    width: 600,
                    height: 600,
                    borderRadius: "50%",
                    background: `radial-gradient(circle, ${scheme.glow} 0%, transparent 70%)`,
                    opacity: glowOpacity,
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -60%)",
                }}
            />

            {/* Icon */}
            <div
                style={{
                    fontSize: 120,
                    opacity: iconOpacity,
                    transform: `scale(${iconScale}) translateY(${iconFloat}px)`,
                    marginBottom: 40,
                    filter: `drop-shadow(0 0 20px ${scheme.shadow})`,
                }}
            >
                ◆
            </div>

            {/* Stat number */}
            <div
                style={{
                    fontFamily: "Inter, sans-serif",
                    fontWeight: 900,
                    fontSize: 160,
                    color: scheme.primary,
                    opacity: numberOpacity,
                    transform: `scale(${numberScale}) translateY(${numberY}px)`,
                    letterSpacing: "-4px",
                    textShadow: `0 0 40px ${scheme.shadow}, 0 4px 12px rgba(0,0,0,0.5)`,
                    lineHeight: 1,
                }}
            >
                {statValue}
            </div>

            {/* Decorative line */}
            <div
                style={{
                    width: lineWidth,
                    height: 2,
                    background: `linear-gradient(90deg, transparent, ${scheme.primary}, transparent)`,
                    margin: "30px 0",
                    opacity: 0.6,
                }}
            />

            {/* Label */}
            <div
                style={{
                    fontFamily: "Inter, sans-serif",
                    fontWeight: 400,
                    fontSize: 44,
                    color: scheme.textSecondary,
                    opacity: labelOpacity,
                    transform: `translateY(${labelY}px)`,
                    letterSpacing: "6px",
                    textTransform: "uppercase",
                }}
            >
                {label}
            </div>
        </AbsoluteFill>
    );
};
