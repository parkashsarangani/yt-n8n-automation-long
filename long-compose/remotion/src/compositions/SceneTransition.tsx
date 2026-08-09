import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface SceneTransitionProps {
    type: "crossfade" | "flash" | "wipe";
}

/**
 * Short transition overlays rendered as clips to be composited
 * between scenes during the final ffmpeg stitch.
 */
export const SceneTransition: React.FC<SceneTransitionProps> = ({ type }) => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();

    if (type === "flash") {
        // Quick white flash + scale punch (2-3 frames bright, then fade)
        const brightness = interpolate(
            frame,
            [0, 2, 4, durationInFrames],
            [0, 1, 0.8, 0],
            { extrapolateRight: "clamp" }
        );

        return (
            <AbsoluteFill
                style={{
                    background: `rgba(255, 255, 255, ${brightness * 0.85})`,
                }}
            />
        );
    }

    if (type === "wipe") {
        // Directional wipe (black bar sweeping across)
        const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
            extrapolateRight: "clamp",
        });
        const barPos = progress * 1200 - 200;

        return (
            <AbsoluteFill style={{ overflow: "hidden" }}>
                <div
                    style={{
                        position: "absolute",
                        top: 0,
                        left: barPos,
                        width: 200,
                        height: "100%",
                        background: "linear-gradient(90deg, transparent, rgba(0,0,0,0.9), transparent)",
                        filter: "blur(4px)",
                    }}
                />
            </AbsoluteFill>
        );
    }

    // Default: crossfade (just an alpha ramp - composited over the cut point)
    const alpha = interpolate(
        frame,
        [0, durationInFrames / 2, durationInFrames],
        [0, 0.15, 0],
        { extrapolateRight: "clamp" }
    );

    return (
        <AbsoluteFill
            style={{
                background: `rgba(0, 0, 0, ${alpha})`,
            }}
        />
    );
};
