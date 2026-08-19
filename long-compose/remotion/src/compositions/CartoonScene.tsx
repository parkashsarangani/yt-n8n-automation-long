import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, CharacterProps } from "../components/Character";
import { Background, BackgroundSpec } from "../components/Background";
import { getScheme, Mood } from "../lib/colors";
import { getEnvironmentEffect } from "../lib/environment";

export interface CartoonCameraProps {
    type?: "static" | "zoom" | "pan";
    from?: number;
    to?: number;
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

function withConversationDirection(characters: CharacterProps[]): CharacterProps[] {
    if (characters.length < 2) return characters;

    return characters.map((character, index) => {
        const base = {
            ...character,
            actorId: character.actorId ?? character.animationKey ?? `${character.characterId}-${index}`,
        };

        if (
            character.gazeX !== undefined ||
            character.gazeY !== undefined ||
            (character.gazeTarget !== undefined && character.gazeTarget !== "auto")
        ) {
            return base;
        }

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

        if (!closest) return base;
        return {
            ...base,
            gazeX: closest.x >= character.x ? 6 : -6,
            gazeY: -0.5,
        };
    });
}

export const CartoonScene: React.FC<CartoonSceneProps> = ({ background, mood = "neutral", characters, camera }) => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const scheme = getScheme(mood);
    const effect = getEnvironmentEffect(background?.tone);
    const endFrame = Math.max(1, durationInFrames - 1);

    const zoomFrom = camera?.from ?? 1;
    const zoomTo = camera?.to ?? zoomFrom;
    const zoom = camera?.type === "zoom"
        ? interpolate(frame, [0, endFrame], [zoomFrom, zoomTo], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: cameraEasing,
        })
        : 1;

    const panX = camera?.type === "pan"
        ? interpolate(frame, [0, endFrame], [camera.panFrom ?? 0, camera.panTo ?? 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: cameraEasing,
        })
        : 0;

    const shakeX = effect.shake > 0 ? Math.sin(frame * 2.3) * effect.shake : 0;
    const shakeY = effect.shake > 0 ? Math.cos(frame * 2.0) * effect.shake : 0;
    const directedCharacters = withConversationDirection(characters);

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }}>
            <AbsoluteFill
                style={{
                    transform: `scale(${zoom}) translate(${shakeX}px, ${shakeY}px)`,
                    transformOrigin: "50% 50%",
                }}
            >
                <Background background={background} panX={panX} />
                <AbsoluteFill style={{ transform: `translateX(${panX}px)` }}>
                    {directedCharacters.map((c, i) => (
                        <Character key={`${c.actorId ?? c.characterId}-${i}`} {...c} />
                    ))}
                </AbsoluteFill>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
