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
    anchor?: "hand" | "table" | "foreground" | "background" | "left" | "right" | "center" | string;
    label?: string;
}

export interface CallbackEchoSpec {
    role?: "seed" | "escalation" | "payoff" | string;
    text?: string;
    label?: string;
    motif?: string;
    propType?: string;
    propState?: string;
    intensity?: "low" | "medium" | "high" | string;
}

export interface PerformanceCueSpec {
    type?: "notice" | "hesitate" | "double-take" | "side-eye" | "deadpan" | "recoil" | "small-defeat" | "reluctant-acceptance" | "point-at-prop" | string;
    label?: string;
    anchor?: "left" | "right" | "center" | "offscreen" | string;
    propType?: string;
    intensity?: "low" | "medium" | "high" | string;
}

export interface MetaphorVisualSpec {
    type?: string;
    label?: string;
    emotionalBeat?: string;
    propType?: string;
    propState?: string;
}

export interface VisualEventSpec {
    type?: VisualEventType;
    label?: string;
    foregroundProp?: ForegroundPropSpec;
    callbackEcho?: CallbackEchoSpec;
    performanceCue?: PerformanceCueSpec;
    metaphorVisual?: MetaphorVisualSpec;
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

function anchorX(anchor?: string): number {
    switch (anchor) {
        case "background": return 1320;
        case "hand": return 1000;
        case "table": return 980;
        case "left": return 95;
        case "right": return 1060;
        case "center":
        case "foreground": return 880;
        default: return 1110;
    }
}

function anchorY(anchor?: string): number {
    switch (anchor) {
        case "background": return 250;
        case "hand": return 515;
        case "table": return 590;
        case "left":
        case "right":
        case "center":
        case "foreground": return 560;
        default: return 575;
    }
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
    const x = anchorX(prop.anchor);
    const y = anchorY(prop.anchor);

    if (type === "phone") {
        const faceDown = /face-down|across/.test(state);
        const screenGlow = /glow|notification|unlocked|thumb/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX + slideX, top: y + hoverY, width: 154, height: 250, borderRadius: 28, background: faceDown ? "#20242C" : "#111827", border: "8px solid #F8FAFC", boxShadow: screenGlow ? `0 0 ${34 + pulse * 28}px rgba(80,190,255,0.58)` : "0 18px 38px rgba(0,0,0,0.28)", transform: `rotate(${prop.anchor === "hand" ? -8 : 5}deg) scale(${scale})`, zIndex: 7 }}>
                {!faceDown && (
                    <div style={{ position: "absolute", left: 14, top: 18, width: 126, height: 210, borderRadius: 18, background: "linear-gradient(180deg,#58C7FF,#1E3A8A)", boxShadow: screenGlow ? "inset 0 0 24px rgba(255,255,255,0.22)" : "none" }} />
                )}
                {motion === "thumb-hover" && (
                    <div style={{ position: "absolute", left: -45, bottom: 35 + hoverY, width: 70, height: 44, borderRadius: 28, background: "#F2C7A5", border: "5px solid rgba(40,35,30,0.45)", transform: "rotate(14deg)", boxShadow: "0 8px 16px rgba(0,0,0,0.18)" }} />
                )}
            </div>
        );
    }

    if (type === "clock" || type === "alarm clock") {
        const minute = -90 + (frame % 120) * 3;
        const urgent = /late|jump|running/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 190, height: 190, borderRadius: 190, background: urgent ? "#FFF2F2" : "#FFFFFF", border: `10px solid ${urgent ? "#EF4444" : "#20242C"}`, boxShadow: urgent ? `0 0 ${24 + pulse * 26}px rgba(239,68,68,0.38)` : "0 18px 38px rgba(0,0,0,0.22)", transform: `scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 84, top: 32, width: 12, height: 60, borderRadius: 6, background: "#20242C", transformOrigin: "6px 58px", transform: "rotate(25deg)" }} />
                <div style={{ position: "absolute", left: 84, top: 36, width: 12, height: 70, borderRadius: 6, background: urgent ? "#EF4444" : "#2563EB", transformOrigin: "6px 64px", transform: `rotate(${minute}deg)` }} />
                <div style={{ position: "absolute", left: 74, top: 74, width: 34, height: 34, borderRadius: 34, background: "#20242C" }} />
            </div>
        );
    }

    if (type === "keys") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 240, height: 130, transform: `rotate(-8deg) scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 12, top: 30, width: 72, height: 72, borderRadius: 72, border: "14px solid #FBBF24", boxShadow: "0 12px 24px rgba(0,0,0,0.22)" }} />
                <div style={{ position: "absolute", left: 74, top: 60, width: 142, height: 18, borderRadius: 10, background: "#F59E0B", boxShadow: "0 12px 24px rgba(0,0,0,0.18)" }} />
                <div style={{ position: "absolute", right: 20, top: 48, width: 22, height: 44, background: "#F59E0B" }} />
                <div style={{ position: "absolute", right: 55, top: 60, width: 18, height: 36, background: "#F59E0B" }} />
            </div>
        );
    }

    if (type === "route-map") {
        const delayed = /traffic|delay|red/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 360, height: 210, borderRadius: 24, background: "#EFF6FF", border: "8px solid #FFFFFF", boxShadow: "0 18px 42px rgba(0,0,0,0.25)", transform: `rotate(3deg) scale(${scale})`, zIndex: 7, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 86, width: 360, height: 18, background: "#BFDBFE" }} />
                <div style={{ position: "absolute", left: 58, top: 26, width: 34, height: 160, borderRadius: 24, background: "#BFDBFE" }} />
                <div style={{ position: "absolute", left: 64, top: 103, width: 230, height: 16, borderRadius: 12, background: delayed ? "#EF4444" : "#22C55E", boxShadow: delayed ? `0 0 ${18 + pulse * 20}px rgba(239,68,68,0.42)` : "0 0 18px rgba(34,197,94,0.28)" }} />
                <div style={{ position: "absolute", left: 274, top: 89, width: 42, height: 42, borderRadius: 42, background: delayed ? "#EF4444" : "#22C55E", border: "6px solid #FFFFFF" }} />
            </div>
        );
    }

    if (type === "calendar") {
        const buffered = /buffer/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 260, height: 210, borderRadius: 22, background: "#FFFFFF", border: "8px solid #20242C", boxShadow: "0 18px 40px rgba(0,0,0,0.24)", transform: `rotate(-3deg) scale(${scale})`, zIndex: 7, overflow: "hidden" }}>
                <div style={{ height: 48, background: buffered ? "#22C55E" : "#2563EB" }} />
                <div style={{ position: "absolute", left: 28, top: 70, right: 28, height: 20, borderRadius: 10, background: "#CBD5E1" }} />
                <div style={{ position: "absolute", left: 28, top: 106, right: buffered ? 28 : 92, height: 20, borderRadius: 10, background: buffered ? "#22C55E" : "#CBD5E1" }} />
                <div style={{ position: "absolute", left: 28, top: 144, right: 64, height: 20, borderRadius: 10, background: "#CBD5E1" }} />
            </div>
        );
    }

    if (type === "door") {
        const open = /open|leaving/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY - 70, width: 170, height: 300, borderRadius: 10, background: open ? "#92400E" : "#78350F", border: "8px solid #451A03", boxShadow: open ? `0 0 ${28 + pulse * 22}px rgba(251,191,36,0.35)` : "0 18px 38px rgba(0,0,0,0.25)", transform: `perspective(360px) rotateY(${open ? -20 : 0}deg) scale(${scale})`, transformOrigin: "left center", zIndex: 7 }}>
                <div style={{ position: "absolute", right: 18, top: 142, width: 18, height: 18, borderRadius: 18, background: "#FBBF24" }} />
            </div>
        );
    }

    if (type === "coffee" || type === "mug") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 160, height: 150, transform: `rotate(-3deg) scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 30, top: 42, width: 100, height: 92, borderRadius: "0 0 32px 32px", background: "#FFFFFF", border: "8px solid #20242C", boxShadow: "0 18px 38px rgba(0,0,0,0.22)" }} />
                <div style={{ position: "absolute", right: 8, top: 60, width: 46, height: 44, borderRadius: 44, border: "8px solid #20242C" }} />
                <div style={{ position: "absolute", left: 52, top: 20 + Math.sin(frame / 8) * 5, width: 16, height: 38, borderRadius: 16, background: "rgba(255,255,255,0.68)" }} />
                <div style={{ position: "absolute", left: 88, top: 14 + Math.sin(frame / 7) * 5, width: 14, height: 48, borderRadius: 14, background: "rgba(255,255,255,0.58)" }} />
            </div>
        );
    }

    if (type === "shoes" || type === "shoe") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 270, height: 130, transform: `rotate(-4deg) scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 10, top: 50, width: 118, height: 54, borderRadius: "48px 28px 18px 18px", background: "#334155", boxShadow: "0 14px 28px rgba(0,0,0,0.22)" }} />
                <div style={{ position: "absolute", left: 142, top: 54, width: 118, height: 54, borderRadius: "48px 28px 18px 18px", background: "#475569", boxShadow: "0 14px 28px rgba(0,0,0,0.22)" }} />
                <div style={{ position: "absolute", left: 28, top: 42, width: 62, height: 8, borderRadius: 8, background: "#F8FAFC" }} />
                <div style={{ position: "absolute", left: 160, top: 46, width: 62, height: 8, borderRadius: 8, background: "#F8FAFC" }} />
            </div>
        );
    }

    if (type === "laptop") {
        const glow = /glow|open|screen/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX + slideX, top: y + hoverY, width: 300, height: 190, transform: `rotate(2deg) scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 42, top: 8, width: 216, height: 126, borderRadius: 16, background: glow ? "linear-gradient(180deg,#38BDF8,#1E3A8A)" : "#334155", border: "8px solid #0F172A", boxShadow: glow ? `0 0 ${24 + pulse * 24}px rgba(56,189,248,0.42)` : "0 14px 28px rgba(0,0,0,0.22)" }} />
                <div style={{ position: "absolute", left: 8, top: 130, width: 284, height: 34, borderRadius: "8px 8px 20px 20px", background: "#CBD5E1", border: "6px solid #0F172A" }} />
            </div>
        );
    }

    if (type === "bed" || type === "sheets") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY - 20, width: 330, height: 150, transform: `scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 0, top: 58, width: 330, height: 72, borderRadius: "26px 26px 18px 18px", background: "#93C5FD", border: "8px solid rgba(15,23,42,0.45)", boxShadow: "0 16px 34px rgba(0,0,0,0.20)" }} />
                <div style={{ position: "absolute", left: 22, top: 22, width: 112, height: 58, borderRadius: 20, background: "#F8FAFC", border: "6px solid rgba(15,23,42,0.26)" }} />
                <div style={{ position: "absolute", right: 18, bottom: 6, width: 46, height: 70, borderRadius: 14, background: "#1E293B" }} />
            </div>
        );
    }

    if (type === "window") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY - 90, width: 230, height: 210, borderRadius: 20, background: "linear-gradient(180deg,#BAE6FD,#FDE68A)", border: "10px solid #F8FAFC", boxShadow: "0 16px 34px rgba(0,0,0,0.20)", transform: `scale(${scale})`, zIndex: 6 }}>
                <div style={{ position: "absolute", left: 100, top: 0, width: 10, height: 210, background: "#F8FAFC" }} />
                <div style={{ position: "absolute", left: 0, top: 94, width: 230, height: 10, background: "#F8FAFC" }} />
            </div>
        );
    }

    return null;
}

function TextlessEventEffect({ event }: { event?: VisualEventSpec }) {
    const frame = useCurrentFrame();
    const type = event?.type ?? "none";
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;

    if (type === "alarm-pulse") {
        return (
            <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.35 + pulse * 0.18 }}>
                <div style={{ position: "absolute", left: 690, top: 220, width: 540, height: 540, borderRadius: 540, border: "10px solid rgba(255,70,70,0.38)", transform: `scale(${0.84 + pulse * 0.16})`, boxShadow: "0 0 70px rgba(255,80,80,0.25)" }} />
            </AbsoluteFill>
        );
    }

    if (type === "audience-silhouette") {
        return (
            <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.7 }}>
                {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} style={{ position: "absolute", bottom: -70, left: 170 + i * 235, width: 125, height: 190 + (i % 2) * 34, borderRadius: "70px 70px 18px 18px", background: "rgba(20,24,32,0.55)", filter: "blur(0.2px)" }} />
                ))}
            </AbsoluteFill>
        );
    }

    if (type === "screen-change") {
        return (
            <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.18 + pulse * 0.08 }}>
                <div style={{ position: "absolute", right: 110, top: 110, width: 360, height: 190, borderRadius: 20, background: "rgba(56,189,248,0.35)", border: "5px solid rgba(255,255,255,0.38)", boxShadow: "0 0 32px rgba(80,190,255,0.35)", transform: `scale(${0.98 + pulse * 0.02})` }} />
            </AbsoluteFill>
        );
    }

    if (type === "reaction-pop") {
        return (
            <div style={{ position: "absolute", left: 748, top: 150, width: 118, height: 118, borderRadius: 118, background: "rgba(255,255,255,0.42)", border: "10px solid rgba(37,99,235,0.50)", transform: `scale(${0.86 + pulse * 0.12})`, boxShadow: "0 16px 44px rgba(0,0,0,0.16)", zIndex: 5 }} />
        );
    }

    if (type === "metaphor-cutaway" || type === "thought-bubble" || type === "callback-card") {
        return (
            <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.16 + pulse * 0.06 }}>
                <div style={{ position: "absolute", left: 100, top: 82, width: 520, height: 170, borderRadius: type === "thought-bubble" ? 72 : 34, background: type === "thought-bubble" ? "rgba(255,255,255,0.32)" : "rgba(37,99,235,0.26)", border: "6px solid rgba(255,255,255,0.24)", boxShadow: "0 18px 46px rgba(0,0,0,0.12)", transform: `scale(${0.98 + pulse * 0.018})` }} />
            </AbsoluteFill>
        );
    }

    return null;
}

function VisualEventOverlay({ event }: { event?: VisualEventSpec }) {
    return (
        <>
            <TextlessEventEffect event={event} />
            <ForegroundPropOverlay prop={event?.foregroundProp} />
        </>
    );
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
