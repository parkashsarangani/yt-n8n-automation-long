import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { getScheme, Mood } from "../lib/colors";
import { backOut, cinematicEase } from "../lib/easing";

interface ComparisonProps {
    leftLabel: string;
    leftValue: string;
    rightLabel: string;
    rightValue: string;
    mood: Mood;
}

export const Comparison: React.FC<ComparisonProps> = ({
    leftLabel,
    leftValue,
    rightLabel,
    rightValue,
    mood,
}) => {
    const frame = useCurrentFrame();
    const scheme = getScheme(mood);

    // Timing
    const leftCardStart = 8;
    const rightCardStart = 18;
    const vsStart = 14;
    const barStart = 28;

    // Left card entrance (slide from left + fade)
    const leftProgress = interpolate(frame, [leftCardStart, leftCardStart + 16], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const leftX = interpolate(frame, [leftCardStart, leftCardStart + 16], [-80, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });
    const leftOpacity = cinematicEase(leftProgress);
    const leftScale = backOut(leftProgress);

    // Right card entrance (slide from right + fade)
    const rightProgress = interpolate(frame, [rightCardStart, rightCardStart + 16], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const rightX = interpolate(frame, [rightCardStart, rightCardStart + 16], [80, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });
    const rightOpacity = cinematicEase(rightProgress);
    const rightScale = backOut(rightProgress);

    // VS badge
    const vsProgress = interpolate(frame, [vsStart, vsStart + 10], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const vsScale = backOut(vsProgress);

    // Animated bar/accent
    const barWidth = interpolate(frame, [barStart, barStart + 24], [0, 100], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });

    const cardStyle = (isRight: boolean): React.CSSProperties => ({
        width: 420,
        padding: "50px 30px",
        borderRadius: 24,
        background: isRight
            ? `linear-gradient(145deg, rgba(${mood === "upbeat" ? "251,191,36" : "96,165,250"},0.12) 0%, rgba(15,15,20,0.95) 100%)`
            : "linear-gradient(145deg, rgba(255,255,255,0.06) 0%, rgba(15,15,20,0.95) 100%)",
        border: `1px solid ${isRight ? scheme.primary + "40" : "rgba(255,255,255,0.08)"}`,
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        backdropFilter: "blur(20px)",
        boxShadow: isRight
            ? `0 20px 60px ${scheme.shadow}, inset 0 1px 0 rgba(255,255,255,0.05)`
            : "0 20px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)",
    });

    return (
        <AbsoluteFill
            style={{
                background: scheme.backgroundGradient,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                gap: 0,
            }}
        >
            {/* Background grid subtle pattern */}
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    backgroundImage: `
            linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
          `,
                    backgroundSize: "60px 60px",
                    opacity: 0.5,
                }}
            />

            {/* Cards container */}
            <div
                style={{
                    display: "flex",
                    gap: 40,
                    alignItems: "center",
                    position: "relative",
                }}
            >
                {/* Left card */}
                <div
                    style={{
                        ...cardStyle(false),
                        opacity: leftOpacity,
                        transform: `translateX(${leftX}px) scale(${leftScale})`,
                    }}
                >
                    <div
                        style={{
                            fontFamily: "Inter, sans-serif",
                            fontWeight: 400,
                            fontSize: 28,
                            color: scheme.textSecondary,
                            letterSpacing: "4px",
                            textTransform: "uppercase",
                        }}
                    >
                        {leftLabel}
                    </div>
                    <div
                        style={{
                            fontFamily: "Inter, sans-serif",
                            fontWeight: 900,
                            fontSize: 72,
                            color: scheme.textPrimary,
                            letterSpacing: "-2px",
                        }}
                    >
                        {leftValue}
                    </div>
                </div>

                {/* VS badge */}
                <div
                    style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        transform: `translate(-50%, -50%) scale(${vsScale})`,
                        width: 64,
                        height: 64,
                        borderRadius: "50%",
                        background: scheme.primary,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: "Inter, sans-serif",
                        fontWeight: 900,
                        fontSize: 22,
                        color: scheme.background,
                        boxShadow: `0 0 30px ${scheme.shadow}`,
                        zIndex: 10,
                    }}
                >
                    VS
                </div>

                {/* Right card */}
                <div
                    style={{
                        ...cardStyle(true),
                        opacity: rightOpacity,
                        transform: `translateX(${rightX}px) scale(${rightScale})`,
                    }}
                >
                    <div
                        style={{
                            fontFamily: "Inter, sans-serif",
                            fontWeight: 400,
                            fontSize: 28,
                            color: scheme.textSecondary,
                            letterSpacing: "4px",
                            textTransform: "uppercase",
                        }}
                    >
                        {rightLabel}
                    </div>
                    <div
                        style={{
                            fontFamily: "Inter, sans-serif",
                            fontWeight: 900,
                            fontSize: 72,
                            color: scheme.primary,
                            letterSpacing: "-2px",
                            textShadow: `0 0 30px ${scheme.shadow}`,
                        }}
                    >
                        {rightValue}
                    </div>
                </div>
            </div>

            {/* Accent bar */}
            <div
                style={{
                    marginTop: 60,
                    height: 3,
                    width: `${barWidth}%`,
                    maxWidth: 600,
                    background: `linear-gradient(90deg, transparent, ${scheme.primary}, transparent)`,
                    borderRadius: 2,
                }}
            />
        </AbsoluteFill>
    );
};
