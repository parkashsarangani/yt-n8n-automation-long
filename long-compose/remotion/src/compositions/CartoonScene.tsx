import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, CharacterProps, CharacterEmphasis } from "../components/Character";
import { Background, BackgroundSpec } from "../components/Background";
import { getScheme, Mood } from "../lib/colors";

export interface CartoonCameraProps {
    type?: "static" | "zoom" | "pan";
    from?: number;
    to?: number;
    panFrom?: number;
    panTo?: number;
}

export type VisualEventType =
    | "none" | "alarm-pulse" | "screen-change" | "audience-silhouette" | "metaphor-cutaway"
    | "prop-tremble" | "thought-bubble" | "reaction-pop" | "callback-card";

export interface VisualEventSpec {
    type?: VisualEventType;
    label?: string;
}

export type SpeakerEmphasis = "none" | "scale-pop" | "rim-glow" | "listener-dim" | "caption-anchor";

export interface CartoonSceneProps {
    background?: BackgroundSpec;
    mood?: Mood;
    characters: CharacterProps[];
    camera?: CartoonCameraProps;
    visualEvent?: VisualEventSpec;
    speakerEmphasis?: SpeakerEmphasis;
}

const cameraEasing = Easing.inOut(Easing.cubic);

function assertNever(value: never): never {
    throw new Error(`Unhandled cartoon direction value: ${value}`);
}

function characterEmphasisFor(value: SpeakerEmphasis): CharacterEmphasis {
    switch (value) {
        case "none":
        case "listener-dim":
            return "none";
        case "scale-pop":
            return "scale-pop";
        case "rim-glow":
            return "rim-glow";
        case "caption-anchor":
            return "caption-anchor";
        default:
            return assertNever(value);
    }
}

function withConversationDirection(characters: CharacterProps[], speakerEmphasis: SpeakerEmphasis = "scale-pop"): CharacterProps[] {
    if (characters.length < 2) {
        const emphasis = characterEmphasisFor(speakerEmphasis);
        return characters.map((character) => character.isSpeaking ? { ...character, emphasis } : character);
    }

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

    const emphasis = characterEmphasisFor(speakerEmphasis);
    const dimListeners = speakerEmphasis === "listener-dim" && resolved.some((character) => character.isSpeaking);

    return resolved.map((character, index) => {
        let directed = character;
        if (
            character.gazeX === undefined &&
            character.gazeY === undefined &&
            (character.gazeTarget === undefined || character.gazeTarget === "auto")
        ) {
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

            if (closest) {
                directed = {
                    ...directed,
                    gazeX: closest.x >= character.x ? 6 : -6,
                    gazeY: -0.5,
                };
            }
        }

        return {
            ...directed,
            emphasis: character.isSpeaking ? emphasis : "none",
            dimmed: character.dimmed ?? (dimListeners && !character.isSpeaking),
        };
    });
}

function VisualEventOverlay({ event }: { event?: VisualEventSpec }) {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const type = event?.type ?? "none";
    const label = event?.label?.trim();
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;
    const enter = interpolate(frame, [0, Math.min(12, durationInFrames)], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    switch (type) {
        case "none":
            return null;
        case "alarm-pulse":
            return (
                <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.35 + pulse * 0.18 }}>
                    <div style={{ position: "absolute", left: 690, top: 220, width: 540, height: 540, borderRadius: 540, border: "10px solid rgba(255,70,70,0.38)", transform: `scale(${0.84 + pulse * 0.16})`, boxShadow: "0 0 70px rgba(255,80,80,0.25)" }} />
                </AbsoluteFill>
            );
        case "audience-silhouette":
            return (
                <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.7 * enter }}>
                    {Array.from({ length: 7 }, (_, i) => (
                        <div key={i} style={{ position: "absolute", bottom: -70, left: 170 + i * 235, width: 125, height: 190 + (i % 2) * 34, borderRadius: "70px 70px 18px 18px", background: "rgba(20,24,32,0.55)", filter: "blur(0.2px)" }} />
                    ))}
                </AbsoluteFill>
            );
        case "screen-change":
            return <div style={{ position: "absolute", right: 110, top: 110, width: 360, height: 190, borderRadius: 20, background: "rgba(20,30,44,0.78)", border: "5px solid rgba(255,255,255,0.75)", boxShadow: "0 0 32px rgba(80,190,255,0.35)", transform: `scale(${0.98 + pulse * 0.02})`, color: "white", fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 34, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>NEW SLIDE</div>;
        case "prop-tremble":
            return <div style={{ position: "absolute", left: 800 + Math.sin(frame / 2) * 4, top: 650 + Math.cos(frame / 3) * 2, width: 180, height: 120, background: "rgba(255,255,255,0.92)", borderRadius: 10, boxShadow: "0 8px 18px rgba(0,0,0,0.18)", transform: `rotate(${Math.sin(frame / 2) * 2}deg)` }} />;
        case "reaction-pop":
            return <div style={{ position: "absolute", left: 760, top: 160, padding: "24px 34px", borderRadius: 36, background: "rgba(255,255,255,0.88)", color: "#20242C", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 58, transform: `scale(${enter * (0.94 + pulse * 0.04)})`, boxShadow: "0 16px 44px rgba(0,0,0,0.22)" }}>!</div>;
        case "metaphor-cutaway":
        case "thought-bubble":
        case "callback-card": {
            const text = label || (type === "metaphor-cutaway" ? "WHAT YOUR BRAIN SEES" : type === "thought-bubble" ? "WHAT IF...?" : "CALLBACK");
            const bubble = type === "thought-bubble";
            return (
                <div style={{ position: "absolute", left: 118, top: 90, maxWidth: 520, padding: "26px 34px", borderRadius: bubble ? 44 : 24, background: bubble ? "rgba(255,255,255,0.84)" : "rgba(18,24,34,0.84)", color: bubble ? "#26313C" : "#FFFFFF", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 44, lineHeight: 1.05, letterSpacing: 0.5, transform: `translateY(${(1 - enter) * -16}px) scale(${0.98 + pulse * 0.015})`, boxShadow: "0 20px 52px rgba(0,0,0,0.24)" }}>
                    {text}
                </div>
            );
        }
        default:
            return assertNever(type);
    }
}

export const CartoonScene: React.FC<CartoonSceneProps> = ({ background, mood = "neutral", characters, camera, visualEvent, speakerEmphasis = "scale-pop" }) => {
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

    const directedCharacters = useMemo(
        () => withConversationDirection(characters, speakerEmphasis),
        [characters, speakerEmphasis],
    );

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }}>
            <AbsoluteFill
                style={{
                    transform: `scale(${zoom})`,
                    transformOrigin: "50% 50%",
                }}
            >
                <Background background={background} panX={panX} />
                <VisualEventOverlay event={visualEvent} />
                <AbsoluteFill style={{ transform: `translateX(${panX}px)` }}>
                    {directedCharacters.map((c, i) => (
                        <Character key={`${c.actorId ?? c.characterId}-${i}`} {...c} />
                    ))}
                </AbsoluteFill>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};