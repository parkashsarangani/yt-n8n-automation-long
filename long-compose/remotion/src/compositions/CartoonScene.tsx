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

    if (type === "clock") {
        const minute = -90 + (frame % 120) * 3;
        const urgent = /late|jump|running/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 190, height: 190, borderRadius: 190, background: urgent ? "#FFF2F2" : "#FFFFFF", border: `10px solid ${urgent ? "#EF4444" : "#20242C"}`, boxShadow: urgent ? `0 0 ${24 + pulse * 26}px rgba(239,68,68,0.38)` : "0 18px 38px rgba(0,0,0,0.22)", transform: `scale(${scale})`, zIndex: 7 }}>
                <div style={{ position: "absolute", left: 84, top: 32, width: 12, height: 60, borderRadius: 6, background: "#20242C", transformOrigin: "6px 58px", transform: "rotate(25deg)" }} />
                <div style={{ position: "absolute", left: 84, top: 36, width: 12, height: 70, borderRadius: 6, background: urgent ? "#EF4444" : "#2563EB", transformOrigin: "6px 64px", transform: `rotate(${minute}deg)` }} />
                <div style={{ position: "absolute", left: 74, top: 74, width: 34, height: 34, borderRadius: 34, background: "#20242C" }} />
                <div style={{ position: "absolute", left: 38, bottom: 28, right: 38, textAlign: "center", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 22, color: urgent ? "#EF4444" : "#20242C" }}>{/buffer|spare/.test(state) ? "+8 MIN" : urgent ? "LATE" : "8:00"}</div>
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
                {/missing|search/.test(state) && <div style={{ position: "absolute", left: 70, top: -18, fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 42, color: "#EF4444" }}>?</div>}
            </div>
        );
    }

    if (type === "route-map") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 360, height: 210, borderRadius: 24, background: "#EFF6FF", border: "8px solid #FFFFFF", boxShadow: "0 18px 42px rgba(0,0,0,0.25)", transform: `rotate(3deg) scale(${scale})`, zIndex: 7, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 86, width: 360, height: 18, background: "#BFDBFE" }} />
                <div style={{ position: "absolute", left: 58, top: 26, width: 34, height: 160, borderRadius: 24, background: "#BFDBFE" }} />
                <div style={{ position: "absolute", left: 64, top: 103, width: 230, height: 16, borderRadius: 12, background: /traffic|delay|red/.test(state) ? "#EF4444" : "#22C55E", boxShadow: /traffic|delay|red/.test(state) ? `0 0 ${18 + pulse * 20}px rgba(239,68,68,0.42)` : "0 0 18px rgba(34,197,94,0.28)" }} />
                <div style={{ position: "absolute", left: 42, bottom: 18, fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 28, color: /traffic|delay|red/.test(state) ? "#EF4444" : "#16A34A" }}>{/traffic|delay|red/.test(state) ? "+12 MIN" : "ON TIME"}</div>
            </div>
        );
    }

    if (type === "calendar") {
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY, width: 260, height: 210, borderRadius: 22, background: "#FFFFFF", border: "8px solid #20242C", boxShadow: "0 18px 40px rgba(0,0,0,0.24)", transform: `rotate(-3deg) scale(${scale})`, zIndex: 7, overflow: "hidden" }}>
                <div style={{ height: 48, background: /buffer/.test(state) ? "#22C55E" : "#2563EB" }} />
                <div style={{ position: "absolute", left: 28, top: 70, right: 28, height: 20, borderRadius: 10, background: "#CBD5E1" }} />
                <div style={{ position: "absolute", left: 28, top: 106, right: /buffer/.test(state) ? 28 : 92, height: 20, borderRadius: 10, background: /buffer/.test(state) ? "#22C55E" : "#CBD5E1" }} />
                <div style={{ position: "absolute", left: 28, bottom: 28, fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 30, color: /buffer/.test(state) ? "#16A34A" : "#20242C" }}>{/buffer/.test(state) ? "+50%" : "PLAN"}</div>
            </div>
        );
    }

    if (type === "door") {
        const open = /open|leaving/.test(state);
        return (
            <div style={{ position: "absolute", left: x + trembleX, top: y + hoverY - 70, width: 170, height: 300, borderRadius: 10, background: open ? "#92400E" : "#78350F", border: "8px solid #451A03", boxShadow: open ? `0 0 ${28 + pulse * 22}px rgba(251,191,36,0.35)` : "0 18px 38px rgba(0,0,0,0.25)", transform: `perspective(360px) rotateY(${open ? -20 : 0}deg) scale(${scale})`, transformOrigin: "left center", zIndex: 7 }}>
                <div style={{ position: "absolute", right: 18, top: 142, width: 18, height: 18, borderRadius: 18, background: "#FBBF24" }} />
                <div style={{ position: "absolute", left: 18, bottom: 22, right: 18, textAlign: "center", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 22, color: "#FDE68A" }}>{open ? "LEAVING" : "DOOR"}</div>
            </div>
        );
    }

    const label = objectLabel(prop);
    return (
        <div style={{ position: "absolute", left: x + trembleX + slideX, top: y + hoverY, minWidth: 180, maxWidth: 300, padding: "22px 26px", borderRadius: 24, background: type === "kettle" || type === "food" || type === "coffee" || type === "shoes" ? "rgba(255,255,255,0.92)" : "rgba(18,24,34,0.86)", color: type === "kettle" || type === "food" || type === "coffee" || type === "shoes" ? "#20242C" : "#FFFFFF", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 28, textAlign: "center", boxShadow: motion === "glow" || motion === "pulse" ? `0 0 ${28 + pulse * 28}px rgba(80,190,255,0.45)` : "0 18px 38px rgba(0,0,0,0.24)", transform: `rotate(${type === "letter" || type === "bill" || type === "document" ? -4 : 2}deg) scale(${scale})`, zIndex: 7 }}>
            {label}
        </div>
    );
}

function CallbackEchoOverlay({ echo }: { echo?: CallbackEchoSpec }) {
    const frame = useCurrentFrame();
    if (!echo?.role || echo.role === "none") return null;
    const role = String(echo.role).toLowerCase();
    const pulse = 0.5 + Math.sin(frame / 7) * 0.5;
    const enter = interpolate(Math.min(frame, 14), [0, 14], [0, 1], { extrapolateRight: "clamp" });
    const text = String(echo.label || echo.text || echo.role).replace(/\s+/g, " ").trim().toUpperCase().slice(0, 42);
    const motif = String(echo.motif || echo.propType || "CALLBACK").replace(/[-_]+/g, " ").toUpperCase().slice(0, 20);
    const top = role === "payoff" ? 612 : role === "escalation" ? 92 : 34;
    const left = role === "payoff" ? 330 : role === "escalation" ? 720 : 70;
    const width = role === "payoff" ? 620 : 460;
    return (
        <div style={{ position: "absolute", left, top, width, minHeight: 88, borderRadius: 28, background: role === "payoff" ? "rgba(20,24,32,0.92)" : "rgba(255,255,255,0.90)", color: role === "payoff" ? "#FFFFFF" : "#20242C", border: role === "payoff" ? "5px solid rgba(255,255,255,0.85)" : "5px solid rgba(32,36,44,0.28)", boxShadow: role === "payoff" ? `0 0 ${30 + pulse * 34}px rgba(251,191,36,0.42)` : "0 18px 42px rgba(0,0,0,0.20)", transform: `translateY(${(1 - enter) * 18}px) scale(${0.98 + pulse * 0.012})`, zIndex: 8, overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 12, background: role === "seed" ? "#60A5FA" : role === "escalation" ? "#F59E0B" : "#22C55E" }} />
            <div style={{ position: "absolute", right: 20, top: 16, padding: "8px 12px", borderRadius: 18, background: role === "payoff" ? "rgba(255,255,255,0.16)" : "rgba(32,36,44,0.08)", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 18, letterSpacing: 1 }}>{role.toUpperCase()}</div>
            <div style={{ padding: "18px 134px 16px 34px", fontFamily: "Inter, sans-serif" }}>
                <div style={{ fontWeight: 900, fontSize: 19, letterSpacing: 1, opacity: 0.72 }}>{motif}</div>
                <div style={{ marginTop: 4, fontWeight: 900, fontSize: role === "payoff" ? 34 : 28, lineHeight: 1.04 }}>{text}</div>
            </div>
        </div>
    );
}

function PerformanceCueOverlay({ cue }: { cue?: PerformanceCueSpec }) {
    const frame = useCurrentFrame();
    if (!cue?.type) return null;
    const type = String(cue.type).toLowerCase();
    const pulse = 0.5 + Math.sin(frame / 5) * 0.5;
    const enter = interpolate(Math.min(frame, 10), [0, 10], [0, 1], { extrapolateRight: "clamp" });
    const anchor = String(cue.anchor || "center");
    const x = anchor === "left" ? 245 : anchor === "right" ? 950 : 610;
    const y = type === "small-defeat" || type === "reluctant-acceptance" ? 486 : 126;
    const label = String(cue.label || type).replace(/\s+/g, " ").trim().slice(0, 54);
    const symbol = type === "double-take" ? "?!" : type === "side-eye" ? "LOOK" : type === "deadpan" ? "..." : type === "recoil" ? "!" : type === "small-defeat" ? "oh." : type === "reluctant-acceptance" ? "fine" : type === "point-at-prop" ? "→" : type === "hesitate" ? "wait" : "";
    return (
        <div style={{ position: "absolute", left: x, top: y, maxWidth: 310, transform: `translateY(${(1 - enter) * -10}px) scale(${0.96 + enter * 0.04})`, zIndex: 9, pointerEvents: "none" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "12px 18px", borderRadius: 999, background: "rgba(255,255,255,0.88)", color: "#20242C", border: "4px solid rgba(32,36,44,0.18)", boxShadow: `0 14px ${28 + pulse * 8}px rgba(0,0,0,0.20)`, fontFamily: "Inter, sans-serif" }}>
                <div style={{ minWidth: 46, height: 46, borderRadius: 46, background: type === "recoil" ? "#FEE2E2" : type === "reluctant-acceptance" ? "#DCFCE7" : "#DBEAFE", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 20 }}>{symbol}</div>
                <div style={{ fontWeight: 850, fontSize: 18, lineHeight: 1.05 }}>{label}</div>
            </div>
        </div>
    );
}

function MetaphorVisualOverlay({ visual }: { visual?: MetaphorVisualSpec }) {
    const frame = useCurrentFrame();
    if (!visual?.type || visual.type === "none") return null;
    const pulse = 0.5 + Math.sin(frame / 8) * 0.5;
    const label = String(visual.label || visual.propType || "VISUAL BEAT").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 34);
    const beat = String(visual.emotionalBeat || "").replace(/\s+/g, " ").trim().slice(0, 58);
    const prop = String(visual.propType || "object").replace(/[-_]+/g, " ").toUpperCase().slice(0, 18);
    return (
        <div style={{ position: "absolute", right: 74, top: 78, width: 360, minHeight: 154, borderRadius: 30, background: "rgba(18,24,34,0.78)", color: "#FFFFFF", boxShadow: `0 20px ${42 + pulse * 16}px rgba(0,0,0,0.28)`, border: "5px solid rgba(255,255,255,0.20)", zIndex: 6, overflow: "hidden", fontFamily: "Inter, sans-serif" }}>
            <div style={{ position: "absolute", left: -42, top: -42, width: 130, height: 130, borderRadius: 130, border: "12px solid rgba(96,165,250,0.38)", transform: `scale(${0.94 + pulse * 0.08})` }} />
            <div style={{ padding: "24px 28px" }}>
                <div style={{ fontSize: 18, fontWeight: 900, opacity: 0.75, letterSpacing: 1 }}>{prop}</div>
                <div style={{ marginTop: 8, fontSize: 34, lineHeight: 1.02, fontWeight: 950 }}>{label}</div>
                {beat && <div style={{ marginTop: 10, fontSize: 18, lineHeight: 1.18, fontWeight: 700, opacity: 0.86 }}>{beat}</div>}
            </div>
        </div>
    );
}

function EventEnhancements({ event }: { event?: VisualEventSpec }) {
    return (
        <>
            <MetaphorVisualOverlay visual={event?.metaphorVisual} />
            <CallbackEchoOverlay echo={event?.callbackEcho} />
            <PerformanceCueOverlay cue={event?.performanceCue} />
        </>
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
            return (
                <>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                    <EventEnhancements event={event} />
                </>
            );
        case "alarm-pulse":
            return (
                <>
                    <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.35 + pulse * 0.18 }}>
                        <div style={{ position: "absolute", left: 690, top: 220, width: 540, height: 540, borderRadius: 540, border: "10px solid rgba(255,70,70,0.38)", transform: `scale(${0.84 + pulse * 0.16})`, boxShadow: "0 0 70px rgba(255,80,80,0.25)" }} />
                    </AbsoluteFill>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                    <EventEnhancements event={event} />
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
                    <EventEnhancements event={event} />
                </>
            );
        case "screen-change":
            return (
                <>
                    {!event?.foregroundProp && <div style={{ position: "absolute", right: 110, top: 110, width: 360, height: 190, borderRadius: 20, background: "rgba(20,30,44,0.78)", border: "5px solid rgba(255,255,255,0.75)", boxShadow: "0 0 32px rgba(80,190,255,0.35)", transform: `scale(${0.98 + pulse * 0.02})`, color: "white", fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 34, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>{label || "NEW SLIDE"}</div>}
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                    <EventEnhancements event={event} />
                </>
            );
        case "prop-tremble":
            return (
                <>
                    <ForegroundPropOverlay prop={event?.foregroundProp || { type: "document", state: "trembling", motion: "tremble", label: label || "PROP" }} />
                    <EventEnhancements event={event} />
                </>
            );
        case "reaction-pop":
            return (
                <>
                    <div style={{ position: "absolute", left: 760, top: 160, padding: "24px 34px", borderRadius: 36, background: "rgba(255,255,255,0.88)", color: "#20242C", fontFamily: "Inter, sans-serif", fontWeight: 900, fontSize: 58, transform: `scale(${enter * (0.94 + pulse * 0.04)})`, boxShadow: "0 16px 44px rgba(0,0,0,0.22)" }}>!</div>
                    <ForegroundPropOverlay prop={event?.foregroundProp} />
                    <EventEnhancements event={event} />
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
                    <EventEnhancements event={event} />
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
