import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
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

const cameraEasing = Easing.inOut(Easing.cubic);

/**
 * Give a two-shot basic eye contact even when the planner did not explicitly
 * direct gaze. Explicit gazeX/gazeY always wins. The current rigs have only a
 * small pupil travel range, so this intentionally returns a restrained offset.
 */
function withConversationGaze(characters: CharacterProps[]): CharacterProps[] {
    if (characters.length < 2) return characters;

    return characters.map((character, index) => {
        if (character.gazeX !== undefined || character.gazeY !== undefined) return character;

        let closest: CharacterProps | undefined;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < characters.length; i++) {
            if (i === index) continue;
            const other = characters[i]!;
            const distance = Math.abs(other.x - character.x);
            if (distance < closestDistance) {
                closest = other;
                closestDistance = distance;
            }
        }

        if (!closest) return character;
        return {
            ...character,
            gazeX: closest.x >= character.x ? 6 : -6,
            gazeY: -0.5,
        };
    });
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

    // Use the last real frame as the interpolation endpoint. Using
    // durationInFrames itself means the requested final camera position is
    // technically one frame beyond the composition and is never rendered.
    const endFrame = Math.max(1, durationInFrames - 1);

    const zoomFrom = camera?.from ?? 1;
    const zoomTo = camera?.to ?? zoomFrom;
    const zoom =
        camera?.type === "zoom"
            ? interpolate(frame, [0, endFrame], [zoomFrom, zoomTo], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: cameraEasing,
            })
            : 1;

    const panX =
        camera?.type === "pan"
            ? interpolate(frame, [0, endFrame], [camera.panFrom ?? 0, camera.panTo ?? 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: cameraEasing,
            })
            : 0;

    // Continuous jitter rather than a one-off bump — reads as handheld
    // tension for the whole scene, not a single flinch.
    const shakeX = effect.shake > 0 ? Math.sin(frame * 2.3) * effect.shake : 0;
    const shakeY = effect.shake > 0 ? Math.cos(frame * 2.0) * effect.shake : 0;
    const directedCharacters = withConversationGaze(characters);

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }}>
            <AbsoluteFill
                style={{
                    transform: `scale(${zoom}) translate(${shakeX}px, ${shakeY}px)`,
                    transformOrigin: "50% 50%",
                }}
            >
                <Background background={background} panX={panX} />
                {/* Characters sit at the same depth as the front background layer, so a pan moves them with the room instead of leaving them glued to the screen. */}
                <AbsoluteFill style={{ transform: `translateX(${panX}px)` }}>
                    {directedCharacters.map((c, i) => (
                        <Character key={`${c.characterId}-${i}`} {...c} />
                    ))}
                </AbsoluteFill>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
