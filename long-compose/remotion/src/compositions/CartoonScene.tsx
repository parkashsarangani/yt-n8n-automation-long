import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, CharacterProps } from "../components/Character";
import { Background, BackgroundSpec } from "../components/Background";
import { getScheme, Mood } from "../lib/colors";

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

    const seenActorIds = new Set<string>();
    const resolved = characters.map((character, index) => {
        let actorId = character.actorId ?? character.animationKey ?? `${character.characterId}-${index}`;
        // Two characters given the same explicit actorId/animationKey would
        // otherwise get the identical deterministic animation phase seed in
        // Character.tsx and move in visible lockstep - the previous fallback
        // only filled in a default when both fields were absent, so an
        // explicit collision passed through untouched. Disambiguate any
        // collision here, not just the missing-identity case.
        if (seenActorIds.has(actorId)) actorId = `${actorId}-dup${index}`;
        seenActorIds.add(actorId);
        return { ...character, actorId };
    });

    return resolved.map((character, index) => {
        if (
            character.gazeX !== undefined ||
            character.gazeY !== undefined ||
            (character.gazeTarget !== undefined && character.gazeTarget !== "auto")
        ) {
            return character;
        }

        let closest: CharacterProps | undefined;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < resolved.length; i++) {
            if (i === index) continue;
            const other = resolved[i]!;
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

export const CartoonScene: React.FC<CartoonSceneProps> = ({ background, mood = "neutral", characters, camera }) => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const scheme = getScheme(mood);
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

    const directedCharacters = withConversationDirection(characters);

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }}>
            <AbsoluteFill
                style={{
                    transform: `scale(${zoom})`,
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
