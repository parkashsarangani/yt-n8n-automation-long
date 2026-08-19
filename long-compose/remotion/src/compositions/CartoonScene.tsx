import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, CharacterProps } from "../components/Character";
import { Background, BackgroundSpec } from "../components/Background";
import { getScheme, Mood } from "../lib/colors";
import { getEnvironmentEffect } from "../lib/environment";

export interface CartoonCameraProps {
    type?: "static" | "zoom" | "pan";
    from?: number;
    to?: number;
    /** px, only used when type is "pan" — drives background parallax and moves characters at the same depth as the front layer. */
    panFrom?: number;
    panTo?: number;
}

export interface CartoonSceneProps {
    background?: BackgroundSpec;
    mood?: Mood;
    characters: CharacterProps[];
    camera?: CartoonCameraProps;
}

export const CartoonScene: React.FC<CartoonSceneProps> = ({
    background,
    mood = "neutral",
    characters,
    camera,
}) => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const scheme = getScheme(mood);
    const effect = getEnvironmentEffect(background?.tone);

    const zoomFrom = camera?.from ?? 1;
    const zoomTo = camera?.to ?? zoomFrom;
    const zoom =
        camera?.type === "zoom"
            ? interpolate(frame, [0, durationInFrames], [zoomFrom, zoomTo], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            })
            : 1;

    const panX =
        camera?.type === "pan"
            ? interpolate(frame, [0, durationInFrames], [camera.panFrom ?? 0, camera.panTo ?? 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
            })
            : 0;

    // Continuous jitter rather than a one-off bump — reads as handheld
    // tension for the whole scene, not a single flinch.
    const shakeX = effect.shake > 0 ? Math.sin(frame * 2.3) * effect.shake : 0;
    const shakeY = effect.shake > 0 ? Math.cos(frame * 2.0) * effect.shake : 0;

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }}>
            <AbsoluteFill style={{ transform: `scale(${zoom}) translate(${shakeX}px, ${shakeY}px)` }}>
                <Background background={background} panX={panX} />
                {/* Characters sit at the same depth as the front background layer, so a pan moves them with the room instead of leaving them glued to the screen. */}
                <AbsoluteFill style={{ transform: `translateX(${panX}px)` }}>
                    {characters.map((c, i) => (
                        <Character key={`${c.characterId}-${i}`} {...c} />
                    ))}
                </AbsoluteFill>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
