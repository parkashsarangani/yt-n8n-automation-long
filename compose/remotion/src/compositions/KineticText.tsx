import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { getScheme, Mood } from "../lib/colors";
import { backOut } from "../lib/easing";

interface KineticTextProps {
    line: string;
    mood: Mood;
}

export const KineticText: React.FC<KineticTextProps> = ({ line, mood }) => {
    const frame = useCurrentFrame();
    const scheme = getScheme(mood);

    const words = line.trim().split(/\s+/);
    const staggerFrames = 5; // frames between each word appearing
    const wordDuration = 12; // frames for each word's entrance animation

    return (
        <AbsoluteFill
            style={{
                background: scheme.backgroundGradient,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 80px",
            }}
        >
            {/* Subtle ambient glow */}
            <div
                style={{
                    position: "absolute",
                    width: 800,
                    height: 800,
                    borderRadius: "50%",
                    background: `radial-gradient(circle, ${scheme.glow} 0%, transparent 60%)`,
                    opacity: interpolate(frame, [0, 30], [0, 0.8], { extrapolateRight: "clamp" }),
                }}
            />

            {/* Words container */}
            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: "12px 20px",
                    maxWidth: 900,
                }}
            >
                {words.map((word, i) => {
                    const wordStart = 6 + i * staggerFrames;
                    const progress = interpolate(
                        frame,
                        [wordStart, wordStart + wordDuration],
                        [0, 1],
                        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                    );

                    const opacity = interpolate(
                        frame,
                        [wordStart, wordStart + 6],
                        [0, 1],
                        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                    );

                    const scale = backOut(progress);

                    const y = interpolate(
                        frame,
                        [wordStart, wordStart + wordDuration],
                        [50, 0],
                        {
                            extrapolateLeft: "clamp",
                            extrapolateRight: "clamp",
                            easing: Easing.out(Easing.cubic),
                        }
                    );

                    // Slight rotation for dynamism
                    const rotation = interpolate(
                        frame,
                        [wordStart, wordStart + wordDuration],
                        [i % 2 === 0 ? -3 : 3, 0],
                        { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }
                    );

                    // Highlight the last word with accent color
                    const isLast = i === words.length - 1;
                    const color = isLast ? scheme.primary : scheme.textPrimary;

                    return (
                        <div
                            key={i}
                            style={{
                                fontFamily: "Inter, sans-serif",
                                fontWeight: 900,
                                fontSize: words.length <= 4 ? 96 : words.length <= 6 ? 80 : 64,
                                color,
                                opacity,
                                transform: `translateY(${y}px) scale(${scale}) rotate(${rotation}deg)`,
                                textShadow: isLast
                                    ? `0 0 40px ${scheme.shadow}, 0 4px 12px rgba(0,0,0,0.6)`
                                    : "0 4px 12px rgba(0,0,0,0.5)",
                                lineHeight: 1.2,
                            }}
                        >
                            {word}
                        </div>
                    );
                })}
            </div>
        </AbsoluteFill>
    );
};
