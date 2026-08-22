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

export interface ForegroundPropSpec {
    type?: string;
    state?: string;
    motion?: "none" | "pulse" | "glow" | "tremble" | "slide-away" | "thumb-hover" | "open" | "close" | "bounce" | string;
    anchor?: "hand" | "table" | "foreground" | "background" | string;
    label?: string;
}

export interface VisualEventSpec {
    type?: VisualEventType;
    label?: string;
    foregroundProp?: ForegroundPropSpec;
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

function phoneScreenText(state: string): string {
    if (/notification|badge/.test(state)) return "1";
    if (/unlocked/.test(state)) return "APP";
    if (/face-down|across/.test(state)) return "";
    if (/thumb/.test(state)) return "...";
    return "PHONE";
}

function objectLabel(prop: ForegroundPropSpec): string {
    const raw = prop.label || prop.state || prop.type || "OBJECT";
    return String(raw).replace(/[-_]+/g, " ").toUpperCase().slice(0, 28);
}

function ForegroundPropOverlay({ prop }: { prop?: ForegroundPropSpec }) {
    const frame = useCurrentFrame();
    if (!prop?.type || prop.type === "none") return null;

    const type = String(prop.type).toLowerCase();
    const state = String(prop.state || "visible").toLowerCase();
    const motion = String(prop.motion || "none").toLowerCase();
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;
    const trembleX = motion === "tremble" ? Math.sin(frame * 1.8) * 5 : 0;
    const slideX = motion === "slide-away" ? interpolate(Math.min(frame, 24), [0, 24], [0, 120], { extrapolateRight: "clamp" }) : 0;
    const hoverY = motion === "thumb-hover" ? Math.sin(frame / 5) * 6 : 0;
    const scale = motion === "pulse" || motion === "glow" ? 1 + pulse * 0.035 : 1;
    const x = prop.anchor === "background" ? 1320 : prop.anchor === "hand" ? 1000 : 1110;
    const y = prop.anchor === "background" ? 250 : prop.anchor === "hand" ? 515 : 575;

    if (type === "phone") {
        const faceDown = /face-down|across/.test(state);
        const screenGlow = /glow|notification|unlocked|thumb/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX + slideX, top: y + hoverY, width: 154, height: 250, borderRadius: 28, background: faceDown ? "#20242C" : "#111827", border: "8px solid #F8FAFC", boxShadow: screenGlow ? `0 0 ${34 + pulse * 28}px rgba(80,190,255,0.58)` : "0 18px 38px rgba(0,0,0,0.28)", transform: `rotate(${prop.anchor === "hand" ? -8 : 5}deg) scale(${scale})`, zIndex: 7 }}>
                {!faceDown && (
                    <div style={{ position: "absolute", left: 14, top: 18, width: 126, height: 210, borderRadius: 18, background: "linear-gradient(180deg,#58C7FF,#1E3A8A)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: /notification|badge/.test(state) ? 86 : 34 }}>
                        {phoneScreenText(state)}
                    </div>
                )}
                {motion === "thumb-hover" && (
                    <div style={{ position: "absolute", left: -45, bottom: 35 + hoverY, width: 70, height: 44, borderRadius: 28, background: "#F2C7A5", border: "5px solid rgba(40,35,30,0.45)", transform: "rotate(14deg)", boxShadow: "0 8px 16px rgba(0,0,0,0.18)" }} />
                )}
            </div>
        );
    }

    const label = objectLabel(prop);
    return (
        <div style={{ position: "absolute", left: x + trembleX + slideX, top: y + hoverY, minWidth: 180, maxWidth: 300, padding: "22px 26px", borderRadius: type === "door" ? 12 : 24, background: type === "kettle" || type === "food" ? "rgba(255,255,255,0.92)" : "rgba(18,24,34,0.86)", color: type === "kettle" || type === "food" ? "#20242C" : "#FFFFFF", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 28, textAlign: "center", boxShadow: motion === "glow" || motion === "pulse" ? `0 0 ${28 + pulse * 28}px rgba(80,190,255,0.45)` : "0 18px 38px rgba(0,0,0,0.24)", transform: `rotate(${type === "letter" || type === "bill" || type === "document" ? -4 : 2}deg) scale(${scale})`, zIndex: 7 }}>
            {label}
        </div>
    );
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
            return event?.foregroundProp ? <ForegroundPropOverlay prop={event.foregroundProp} /> : null;
        case "alarm-pulse":
            return (
                <>
                    <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.35 + pulse * 0.18 }}>
                        <div style={{ position: "absolute", left: 690, top: 220, width: 540, height: 540, borderRadius: 540, border: "10px solid rgba(255,70,70,0.38)", transform: `scale(${0.84 + pulse * 0.16})`, boxShadow: "0 0 70px rgba(255,80,80,0.25)" }} />
                    </AbsoluteFill>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                </>
            );
        case "audience-silhouette":
            return (
                <>
                    <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.7 * enter }}>
                        {Array.from({ length: 7 }, (_, i) => (
                            <div key={i} style={{ position: "absolute", bottom: -70, left: 170 + i * 235, width: 125, height: 190 + (i % 2) * 34, borderRadius: "70px 70px 18px 18px", background: "rgba(20,24,32,0.55)", filter: "blur(0.2px)" }} />
                        ))}
                    </AbsoluteFill>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                </>
            );
        case "screen-change":
            return (
                <>
                    {!event?.foregroundProp && <div style={{ position: "absolute", right: 110, top: 110, width: 360, height: 190, borderRadius: 20, background: "rgba(20,30,44,0.78)", border: "5px solid rgba(255,255,255,0.75)", boxShadow: "0 0 32px rgba(80,190,255,0.35)", transform: `scale(${0.98 + pulse * 0.02})`, color: "white", fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 34, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>{label || "NEW SLIDE"}</div>}
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                </>
            );
        case "prop-tremble":
            return <ForegroundPropOverlay prop={event?.foregroundProp || { type: "document", state: "trembling", motion: "tremble", label: label || "PROP" }} />;
        case "reaction-pop":
            return (
                <>
                    <div style={{ position: "absolute", left: 760, top: 160, padding: "24px 34px", borderRadius: 36, background: "rgba(255,255,255,0.88)", color: "#20242C", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 58, transform: `scale(${enter * (0.94 + pulse * 0.04)})`, boxShadow: "0 16px 44px rgba(0,0,0,0.22)" }}>!</div>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                </>
            );
        case "metaphor-cutaway":
        case "thought-bubble":
        case "callback-card": {
            const text = label || (type === "metaphor-cutaway" ? "WHAT YOUR BRAIN SEES" : type === "thought-bubble" ? "WHAT IF...?" : "CALLBACK");
            const bubble = type === "thought-bubble";
            return (
                <>
                    <div style={{ position: "absolute", left: 118, top: 90, maxWidth: 520, padding: "26px 34px", borderRadius: bubble ? 44 : 24, background: bubble ? "rgba(255,255,255,0.84)" : "rgba(18,24,34,0.84)", color: bubble ? "#26313C" : "#FFFFFF", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 44, lineHeight: 1.05, letterSpacing: 0.5, transform: `translateY(${(1 - enter) * -16}px) scale(${0.98 + pulse * 0.015})`, boxShadow: "0 20px 52px rgba(0,0,0,0.24)" }}>
                        {text}
                    </div>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                </>
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