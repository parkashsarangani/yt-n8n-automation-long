import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface Word {
    text: string;
    start: number; // seconds
    end: number; // seconds
}

interface CaptionOverlayProps {
    words: Word[];
    commentHook: string;
    totalDuration: number;
}

/**
 * Studio-grade caption overlay with:
 * - Per-word highlight with scale punch
 * - Smooth 2-word grouping
 * - Large soft shadow for readability
 * - Comment hook with pop-in at the end
 */
export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
    words,
    commentHook,
    totalDuration,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const currentTime = frame / fps;

    const WORDS_PER_CHUNK = 2;

    // Group words into display chunks
    const chunks: Word[][] = [];
    for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
        chunks.push(words.slice(i, i + WORDS_PER_CHUNK));
    }

    // Find which chunk is currently active
    const activeChunk = chunks.find((chunk) => {
        const chunkStart = chunk[0]?.start ?? 0;
        const chunkEnd = chunk[chunk.length - 1]?.end ?? 0;
        return currentTime >= chunkStart && currentTime <= chunkEnd;
    });

    // Comment hook timing
    const hookDuration = Math.min(2.0, totalDuration * 0.4);
    const hookStart = totalDuration - hookDuration;
    const showHook = commentHook && currentTime >= hookStart;

    const hookProgress = showHook
        ? interpolate(
            frame,
            [hookStart * fps, hookStart * fps + 8],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        )
        : 0;

    return (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
            {/* Caption area - fixed position for consistency */}
            <div
                style={{
                    position: "absolute",
                    bottom: 480,
                    left: 60,
                    right: 60,
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    minHeight: 120,
                }}
            >
                {activeChunk && (
                    <div
                        style={{
                            display: "flex",
                            gap: 16,
                            justifyContent: "center",
                            flexWrap: "wrap",
                        }}
                    >
                        {activeChunk.map((word, i) => {
                            const isActive = currentTime >= word.start && currentTime <= word.end;

                            // Scale punch on active word
                            const wordFrame = word.start * fps;
                            const scaleProgress = interpolate(
                                frame,
                                [wordFrame, wordFrame + 3, wordFrame + 6],
                                [0.85, 1.08, 1.0],
                                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                            );

                            return (
                                <span
                                    key={`${word.text}-${i}`}
                                    style={{
                                        fontFamily: "Inter, sans-serif",
                                        fontWeight: 900,
                                        fontSize: 76,
                                        color: isActive ? "#FFFF00" : "#FFFFFF",
                                        transform: `scale(${isActive ? scaleProgress : 1.0})`,
                                        textShadow: isActive
                                            ? "0 0 20px rgba(255,255,0,0.5), 0 4px 16px rgba(0,0,0,0.8)"
                                            : "0 4px 16px rgba(0,0,0,0.8), 0 0 0 rgba(0,0,0,0.3)",
                                        textTransform: "uppercase",
                                        letterSpacing: "-1px",
                                        transition: "color 0.05s",
                                    }}
                                >
                                    {word.text}
                                </span>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Comment hook pop-in */}
            {showHook && (
                <div
                    style={{
                        position: "absolute",
                        bottom: 700,
                        left: 80,
                        right: 80,
                        display: "flex",
                        justifyContent: "center",
                    }}
                >
                    <div
                        style={{
                            fontFamily: "Inter, sans-serif",
                            fontWeight: 800,
                            fontSize: 52,
                            color: "#FFFFFF",
                            textAlign: "center",
                            padding: "20px 40px",
                            borderRadius: 16,
                            background: "rgba(0, 0, 0, 0.7)",
                            backdropFilter: "blur(10px)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            transform: `scale(${hookProgress})`,
                            opacity: hookProgress,
                            textShadow: "0 2px 8px rgba(0,0,0,0.5)",
                            textTransform: "uppercase",
                            letterSpacing: "1px",
                        }}
                    >
                        {commentHook}
                    </div>
                </div>
            )}
        </AbsoluteFill>
    );
};
