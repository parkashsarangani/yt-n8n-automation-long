import { useMemo, type CSSProperties, type ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, CharacterEmphasis, CharacterProps } from "../components/Character";
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

export type CartoonShotType = "wide" | "medium" | "close-up" | "prop-close-up" | "doorway-transition" | "counter-shot" | "table-shot";
export type CartoonVisualStyleName = "clean-flat" | "warm-modern" | "bold-outline" | "soft-editorial";

export interface CartoonVisualStyle {
    name?: CartoonVisualStyleName | string;
    lineWeight?: number;
    shadow?: "none" | "soft-offset" | "deep-stage" | string;
    depth?: "flat" | "layered-parallax" | "stage-depth" | string;
    lighting?: "neutral" | "warm-window" | "cool-monitor" | "morning-soft" | string;
    propScale?: number;
    palette?: {
        outline?: string;
        paper?: string;
        accent?: string;
        accent2?: string;
        surface?: string;
        shadow?: string;
    };
}

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
    shotType?: CartoonShotType;
    visualStyle?: CartoonVisualStyle | CartoonVisualStyleName;
}

interface ResolvedVisualStyle {
    name: string;
    lineWeight: number;
    shadow: "none" | "soft-offset" | "deep-stage";
    depth: "flat" | "layered-parallax" | "stage-depth";
    lighting: "neutral" | "warm-window" | "cool-monitor" | "morning-soft";
    propScale: number;
    palette: {
        outline: string;
        paper: string;
        accent: string;
        accent2: string;
        surface: string;
        shadow: string;
    };
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
                directed = { ...directed, gazeX: closest.x >= character.x ? 6 : -6, gazeY: -0.5 };
            }
        }

        return {
            ...directed,
            emphasis: character.isSpeaking ? emphasis : "none",
            dimmed: character.dimmed ?? (dimListeners && !character.isSpeaking),
        };
    });
}

const STYLE_PRESETS: Record<CartoonVisualStyleName, ResolvedVisualStyle> = {
    "clean-flat": { name: "clean-flat", lineWeight: 6, shadow: "soft-offset", depth: "layered-parallax", lighting: "neutral", propScale: 1, palette: { outline: "#18212F", paper: "#F8FAFC", accent: "#2563EB", accent2: "#38BDF8", surface: "#E2E8F0", shadow: "rgba(15,23,42,0.24)" } },
    "warm-modern": { name: "warm-modern", lineWeight: 7, shadow: "soft-offset", depth: "stage-depth", lighting: "warm-window", propScale: 1.04, palette: { outline: "#1F2937", paper: "#FFF7ED", accent: "#F97316", accent2: "#38BDF8", surface: "#FDE68A", shadow: "rgba(90,55,20,0.24)" } },
    "bold-outline": { name: "bold-outline", lineWeight: 10, shadow: "deep-stage", depth: "stage-depth", lighting: "neutral", propScale: 1.08, palette: { outline: "#0F172A", paper: "#F8FAFC", accent: "#DC2626", accent2: "#2563EB", surface: "#F1F5F9", shadow: "rgba(2,6,23,0.34)" } },
    "soft-editorial": { name: "soft-editorial", lineWeight: 5, shadow: "soft-offset", depth: "layered-parallax", lighting: "morning-soft", propScale: 1, palette: { outline: "#334155", paper: "#FFFFFF", accent: "#14B8A6", accent2: "#A78BFA", surface: "#E0F2FE", shadow: "rgba(51,65,85,0.18)" } },
};

function resolveVisualStyle(style?: CartoonVisualStyle | CartoonVisualStyleName): ResolvedVisualStyle {
    const input: CartoonVisualStyle = typeof style === "string" ? { name: style } : (style ?? {});
    const base = STYLE_PRESETS[input.name as CartoonVisualStyleName] ?? STYLE_PRESETS["warm-modern"];
    return {
        ...base,
        name: input.name ?? base.name,
        lineWeight: input.lineWeight ?? base.lineWeight,
        shadow: input.shadow === "none" || input.shadow === "soft-offset" || input.shadow === "deep-stage" ? input.shadow : base.shadow,
        depth: input.depth === "flat" || input.depth === "layered-parallax" || input.depth === "stage-depth" ? input.depth : base.depth,
        lighting: input.lighting === "neutral" || input.lighting === "warm-window" || input.lighting === "cool-monitor" || input.lighting === "morning-soft" ? input.lighting : base.lighting,
        propScale: input.propScale ?? base.propScale,
        palette: { ...base.palette, ...(input.palette ?? {}) },
    };
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

function motionStyle(prop: ForegroundPropSpec, frame: number, style: ResolvedVisualStyle) {
    const motion = String(prop.motion || "none").toLowerCase();
    const trembleX = motion === "tremble" ? Math.sin(frame * 1.8) * 5 : 0;
    const slideX = motion === "slide-away" ? interpolate(Math.min(frame, 24), [0, 24], [0, 120], { extrapolateRight: "clamp" }) : 0;
    const hoverY = motion === "thumb-hover" || motion === "bounce" ? Math.sin(frame / 5) * 6 : 0;
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;
    const scale = style.propScale * (motion === "pulse" || motion === "glow" || motion === "bounce" ? 1 + pulse * 0.04 : 1);
    return { trembleX, slideX, hoverY, pulse, scale };
}

function propShadow(style: ResolvedVisualStyle): string {
    switch (style.shadow) {
        case "none": return "none";
        case "soft-offset": return `0 16px 34px ${style.palette.shadow}`;
        case "deep-stage": return `0 24px 54px ${style.palette.shadow}`;
        default: return assertNever(style.shadow);
    }
}

function outline(style: ResolvedVisualStyle): string {
    return `${style.lineWeight}px solid ${style.palette.outline}`;
}

function shotOffset(shotType: CartoonShotType): { x: number; y: number; scale: number } {
    switch (shotType) {
        case "wide": return { x: 0, y: 0, scale: 0.82 };
        case "medium": return { x: 0, y: 0, scale: 1 };
        case "close-up": return { x: -40, y: 22, scale: 1.08 };
        case "prop-close-up": return { x: -250, y: -70, scale: 1.42 };
        case "doorway-transition": return { x: -85, y: -16, scale: 1.05 };
        case "counter-shot": return { x: -105, y: -42, scale: 1.18 };
        case "table-shot": return { x: -70, y: -58, scale: 1.12 };
        default: return assertNever(shotType);
    }
}

function propTransform(shotType: CartoonShotType, scale: number, rotate = "0deg"): string {
    const shot = shotOffset(shotType);
    return `rotate(${rotate}) scale(${scale * shot.scale})`;
}

function propBaseStyle(x: number, y: number, transform: string, style: ResolvedVisualStyle, zIndex = 7): CSSProperties {
    return { position: "absolute", left: x, top: y, transform, zIndex, filter: style.shadow === "deep-stage" ? "drop-shadow(0 18px 22px rgba(15,23,42,0.18))" : undefined };
}

function ForegroundPropOverlay({ prop, visualStyle, shotType }: { prop?: ForegroundPropSpec; visualStyle: ResolvedVisualStyle; shotType: CartoonShotType }) {
    const frame = useCurrentFrame();
    if (!prop?.type || prop.type === "none") return null;

    const type = String(prop.type).toLowerCase();
    const state = String(prop.state || "visible").toLowerCase();
    const shot = shotOffset(shotType);
    const { trembleX, slideX, hoverY, pulse, scale } = motionStyle(prop, frame, visualStyle);
    const x = anchorX(prop.anchor) + shot.x + trembleX + slideX;
    const y = anchorY(prop.anchor) + shot.y + hoverY;
    const border = outline(visualStyle);
    const shadow = propShadow(visualStyle);
    const { outline: stroke, paper, accent, accent2, surface } = visualStyle.palette;

    if (type === "phone") {
        const faceDown = /face-down|across/.test(state);
        const glow = /glow|notification|unlocked|thumb/.test(state);
        return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, prop.anchor === "hand" ? "-8deg" : "5deg"), visualStyle), width: 154, height: 250, borderRadius: 28, background: faceDown ? "#20242C" : "#111827", border, boxShadow: glow ? `0 0 ${34 + pulse * 28}px rgba(80,190,255,0.58)` : shadow }}>{!faceDown && <div style={{ position: "absolute", left: 14, top: 18, width: 126, height: 210, borderRadius: 18, background: `linear-gradient(180deg,${accent2},#1E3A8A)`, boxShadow: glow ? "inset 0 0 24px rgba(255,255,255,0.22)" : "none" }} />}{String(prop.motion || "").toLowerCase() === "thumb-hover" && <div style={{ position: "absolute", left: -45, bottom: 35 + hoverY, width: 70, height: 44, borderRadius: 28, background: "#F2C7A5", border: "5px solid rgba(40,35,30,0.45)", transform: "rotate(14deg)", boxShadow: "0 8px 16px rgba(0,0,0,0.18)" }} />}</div>;
    }
    if (type === "clock" || type === "alarm clock") {
        const urgent = /late|jump|running/.test(state);
        const minute = -90 + (frame % 120) * 3;
        return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale), visualStyle), width: 190, height: 190, borderRadius: 190, background: urgent ? "#FFF2F2" : paper, border, boxShadow: urgent ? `0 0 ${24 + pulse * 26}px rgba(239,68,68,0.38)` : shadow }}><div style={{ position: "absolute", left: 84, top: 32, width: 12, height: 60, borderRadius: 6, background: stroke, transformOrigin: "6px 58px", transform: "rotate(25deg)" }} /><div style={{ position: "absolute", left: 84, top: 36, width: 12, height: 70, borderRadius: 6, background: urgent ? "#EF4444" : accent2, transformOrigin: "6px 64px", transform: `rotate(${minute}deg)` }} /><div style={{ position: "absolute", left: 74, top: 74, width: 34, height: 34, borderRadius: 34, background: stroke }} /></div>;
    }
    if (type === "keys") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "-8deg"), visualStyle), width: 240, height: 130 }}><div style={{ position: "absolute", left: 12, top: 30, width: 72, height: 72, borderRadius: 72, border: `${visualStyle.lineWeight * 2}px solid ${accent}`, boxShadow: shadow }} /><div style={{ position: "absolute", left: 74, top: 60, width: 142, height: 18, borderRadius: 10, background: accent, boxShadow: shadow }} /><div style={{ position: "absolute", right: 20, top: 48, width: 22, height: 44, background: accent }} /><div style={{ position: "absolute", right: 55, top: 60, width: 18, height: 36, background: accent }} /></div>;
    if (type === "route-map") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "3deg"), visualStyle), width: 360, height: 210, borderRadius: 24, background: "#EFF6FF", border: `${visualStyle.lineWeight}px solid ${paper}`, boxShadow: shadow, overflow: "hidden" }}><div style={{ position: "absolute", left: 0, top: 86, width: 360, height: 18, background: "#BFDBFE" }} /><div style={{ position: "absolute", left: 58, top: 26, width: 34, height: 160, borderRadius: 24, background: "#BFDBFE" }} /><div style={{ position: "absolute", left: 64, top: 103, width: 230, height: 16, borderRadius: 12, background: /traffic|delay|red/.test(state) ? "#EF4444" : "#22C55E", boxShadow: /traffic|delay|red/.test(state) ? `0 0 ${18 + pulse * 20}px rgba(239,68,68,0.42)` : "0 0 18px rgba(34,197,94,0.28)" }} /><div style={{ position: "absolute", left: 274, top: 89, width: 42, height: 42, borderRadius: 42, background: /traffic|delay|red/.test(state) ? "#EF4444" : "#22C55E", border: `${visualStyle.lineWeight}px solid ${paper}` }} /></div>;
    if (type === "calendar") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "-3deg"), visualStyle), width: 260, height: 210, borderRadius: 22, background: paper, border, boxShadow: shadow, overflow: "hidden" }}><div style={{ height: 48, background: /buffer/.test(state) ? "#22C55E" : accent2 }} /><div style={{ position: "absolute", left: 28, top: 70, right: 28, height: 20, borderRadius: 10, background: "#CBD5E1" }} /><div style={{ position: "absolute", left: 28, top: 106, right: /buffer/.test(state) ? 28 : 92, height: 20, borderRadius: 10, background: /buffer/.test(state) ? "#22C55E" : "#CBD5E1" }} /><div style={{ position: "absolute", left: 28, top: 144, right: 64, height: 20, borderRadius: 10, background: "#CBD5E1" }} /></div>;
    if (type === "door") return <div style={{ ...propBaseStyle(x, y - 70, propTransform(shotType, scale), visualStyle), width: 170, height: 300, borderRadius: 10, background: /open|leaving/.test(state) ? "#92400E" : "#78350F", border: `${visualStyle.lineWeight}px solid #451A03`, boxShadow: /open|leaving/.test(state) ? `0 0 ${28 + pulse * 22}px rgba(251,191,36,0.35)` : shadow, transformOrigin: "left center" }}><div style={{ position: "absolute", right: 18, top: 142, width: 18, height: 18, borderRadius: 18, background: accent }} /></div>;
    if (type === "coffee" || type === "mug") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "-3deg"), visualStyle), width: 160, height: 150 }}><div style={{ position: "absolute", left: 30, top: 42, width: 100, height: 92, borderRadius: "0 0 32px 32px", background: paper, border, boxShadow: shadow }} /><div style={{ position: "absolute", right: 8, top: 60, width: 46, height: 44, borderRadius: 44, border }} /><div style={{ position: "absolute", left: 52, top: 20 + Math.sin(frame / 8) * 5, width: 16, height: 38, borderRadius: 16, background: "rgba(255,255,255,0.68)" }} /><div style={{ position: "absolute", left: 88, top: 14 + Math.sin(frame / 7) * 5, width: 14, height: 48, borderRadius: 14, background: "rgba(255,255,255,0.58)" }} /></div>;
    if (type === "shoes" || type === "shoe") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "-4deg"), visualStyle), width: 270, height: 130 }}><div style={{ position: "absolute", left: 10, top: 50, width: 118, height: 54, borderRadius: "48px 28px 18px 18px", background: stroke, boxShadow: shadow }} /><div style={{ position: "absolute", left: 142, top: 54, width: 118, height: 54, borderRadius: "48px 28px 18px 18px", background: "#475569", boxShadow: shadow }} /><div style={{ position: "absolute", left: 28, top: 42, width: 62, height: 8, borderRadius: 8, background: paper }} /><div style={{ position: "absolute", left: 160, top: 46, width: 62, height: 8, borderRadius: 8, background: paper }} /></div>;
    if (type === "laptop") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "2deg"), visualStyle), width: 300, height: 190 }}><div style={{ position: "absolute", left: 42, top: 8, width: 216, height: 126, borderRadius: 16, background: /glow|open|screen/.test(state) ? `linear-gradient(180deg,${accent2},#1E3A8A)` : "#334155", border: `${visualStyle.lineWeight}px solid #0F172A`, boxShadow: /glow|open|screen/.test(state) ? `0 0 ${24 + pulse * 24}px rgba(56,189,248,0.42)` : shadow }} /><div style={{ position: "absolute", left: 8, top: 130, width: 284, height: 34, borderRadius: "8px 8px 20px 20px", background: "#CBD5E1", border: `${visualStyle.lineWeight}px solid #0F172A` }} /></div>;
    if (type === "bed" || type === "sheets") return <div style={{ ...propBaseStyle(x, y - 20, propTransform(shotType, scale), visualStyle), width: 330, height: 150 }}><div style={{ position: "absolute", left: 0, top: 58, width: 330, height: 72, borderRadius: "26px 26px 18px 18px", background: "#93C5FD", border: `${visualStyle.lineWeight}px solid rgba(15,23,42,0.45)`, boxShadow: shadow }} /><div style={{ position: "absolute", left: 22, top: 22, width: 112, height: 58, borderRadius: 20, background: paper, border: `${Math.max(4, visualStyle.lineWeight - 1)}px solid rgba(15,23,42,0.26)` }} /><div style={{ position: "absolute", right: 18, bottom: 6, width: 46, height: 70, borderRadius: 14, background: "#1E293B" }} /></div>;
    if (type === "window") return <div style={{ ...propBaseStyle(x, y - 90, propTransform(shotType, scale), visualStyle, 6), width: 230, height: 210, borderRadius: 20, background: "linear-gradient(180deg,#BAE6FD,#FDE68A)", border: `${visualStyle.lineWeight + 2}px solid ${paper}`, boxShadow: shadow }}><div style={{ position: "absolute", left: 100, top: 0, width: 10, height: 210, background: paper }} /><div style={{ position: "absolute", left: 0, top: 94, width: 230, height: 10, background: paper }} /></div>;
    if (type === "kettle") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale), visualStyle), width: 200, height: 170 }}><div style={{ position: "absolute", left: 30, top: 40, width: 130, height: 110, borderRadius: "50% 50% 30% 30% / 60% 60% 20% 20%", background: surface, border, boxShadow: /boil|steam|hot|whistl/.test(state) ? `0 0 ${20 + pulse * 22}px rgba(248,113,113,0.4)` : shadow }} /><div style={{ position: "absolute", left: 4, top: 66, width: 46, height: 56, borderRadius: "24px 6px 6px 24px", border: `${visualStyle.lineWeight + 2}px solid ${stroke}`, borderRight: "none" }} /><div style={{ position: "absolute", right: 6, top: 46, width: 44, height: 26, borderRadius: "0 18px 18px 0", background: stroke, transform: "rotate(-18deg)" }} />{/boil|steam|hot|whistl/.test(state) && <div style={{ position: "absolute", right: 24, top: 6 + Math.sin(frame / 7) * 6, width: 12, height: 34, borderRadius: 12, background: "rgba(255,255,255,0.68)" }} />}</div>;
    if (type === "food") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale), visualStyle), width: 220, height: 130 }}><div style={{ position: "absolute", left: 0, top: 50, width: 220, height: 68, borderRadius: 110, background: paper, border: `${visualStyle.lineWeight}px solid #CBD5E1`, boxShadow: shadow }} /><div style={{ position: "absolute", left: 46, top: 24, width: 128, height: 64, borderRadius: "60% 60% 40% 40%", background: accent }} /><div style={{ position: "absolute", left: 76, top: 30, width: 40, height: 30, borderRadius: "50%", background: "#EF4444" }} /></div>;
    if (type === "document") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "-2deg"), visualStyle), width: 200, height: 240 }}><div style={{ position: "absolute", left: 0, top: 0, width: 200, height: 240, background: paper, border, boxShadow: shadow }}><div style={{ position: "absolute", right: 0, top: 0, width: 0, height: 0, borderStyle: "solid", borderWidth: "0 0 30px 30px", borderColor: "transparent transparent #CBD5E1 transparent" }} />{[40, 76, 112, 148].map((topOffset) => <div key={topOffset} style={{ position: "absolute", left: 20, top: topOffset, width: 160, height: 12, borderRadius: 6, background: "#CBD5E1" }} />)}</div></div>;
    if (type === "locker" || type === "cabinet") return <div style={{ ...propBaseStyle(x, y - 60, `perspective(360px) rotateY(${/open/.test(state) ? -14 : 0}deg) ${propTransform(shotType, scale)}`, visualStyle), width: 180, height: 280, transformOrigin: "left center" }}><div style={{ position: "absolute", left: 0, top: 0, width: 180, height: 280, borderRadius: 12, background: "#64748B", border: `${visualStyle.lineWeight}px solid #1E293B`, boxShadow: /open/.test(state) ? `0 0 ${22 + pulse * 20}px rgba(148,163,184,0.4)` : shadow }}><div style={{ position: "absolute", left: 0, top: 138, width: 180, height: 8, background: "#1E293B" }} /><div style={{ position: "absolute", left: 158, top: 66, width: 12, height: 12, borderRadius: 12, background: accent }} /><div style={{ position: "absolute", left: 158, top: 200, width: 12, height: 12, borderRadius: 12, background: accent }} /></div></div>;
    if (type === "vehicle" || type === "car") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale), visualStyle), width: 280, height: 130 }}><div style={{ position: "absolute", left: 20, top: 20, width: 240, height: 70, borderRadius: "24px 24px 12px 12px", background: accent2, boxShadow: shadow }} /><div style={{ position: "absolute", left: 78, top: -6, width: 130, height: 46, borderRadius: "18px 18px 0 0", background: "#93C5FD", border: `${visualStyle.lineWeight}px solid #1E3A8A` }} /><div style={{ position: "absolute", left: 44, top: 78, width: 52, height: 52, borderRadius: 52, background: "#1E293B", border: `${visualStyle.lineWeight}px solid #475569` }} /><div style={{ position: "absolute", left: 190, top: 78, width: 52, height: 52, borderRadius: 52, background: "#1E293B", border: `${visualStyle.lineWeight}px solid #475569` }} /></div>;
    if (type === "tool") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "-30deg"), visualStyle), width: 200, height: 200 }}><div style={{ position: "absolute", left: 82, top: 60, width: 26, height: 130, borderRadius: 10, background: "#92400E" }} /><div style={{ position: "absolute", left: 40, top: 10, width: 110, height: 60, borderRadius: 14, background: "#64748B", border: `${visualStyle.lineWeight}px solid #334155`, boxShadow: shadow }} /></div>;
    if (type === "appliance" || type === "device") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale), visualStyle), width: 220, height: 220 }}><div style={{ position: "absolute", left: 0, top: 0, width: 220, height: 220, borderRadius: 24, background: surface, border: `${visualStyle.lineWeight}px solid #334155`, boxShadow: /glow|on|running/.test(state) ? `0 0 ${24 + pulse * 26}px rgba(56,189,248,0.42)` : shadow }}><div style={{ position: "absolute", left: 20, top: 20, width: 180, height: 130, borderRadius: 12, background: /glow|on|running/.test(state) ? `linear-gradient(180deg,${accent2},#1E3A8A)` : "#1E293B" }} /><div style={{ position: "absolute", left: 20, top: 166, width: 40, height: 40, borderRadius: 40, background: /glow|on|running/.test(state) ? "#22C55E" : "#64748B" }} /></div></div>;
    if (type === "bill" || type === "invoice" || type === "receipt") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale, "3deg"), visualStyle), width: 150, height: 240 }}><div style={{ position: "absolute", left: 0, top: 0, width: 150, height: 220, background: paper, boxShadow: shadow }}>{[30, 60, 90, 120, 150].map((topOffset) => <div key={topOffset} style={{ position: "absolute", left: 16, top: topOffset, width: 118, height: 10, borderRadius: 5, background: "#CBD5E1" }} />)}</div><div style={{ position: "absolute", left: 0, top: 216, width: 150, height: 14, background: "repeating-linear-gradient(-45deg,#FFFFFF,#FFFFFF 8px,transparent 8px,transparent 16px)" }} /></div>;
    if (type === "letter" || type === "envelope") return <div style={{ ...propBaseStyle(x, y, propTransform(shotType, scale), visualStyle), width: 220, height: 150 }}><div style={{ position: "absolute", left: 0, top: 0, width: 220, height: 150, borderRadius: 10, background: paper, border: `${visualStyle.lineWeight}px solid #334155`, boxShadow: shadow }} /><div style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, borderStyle: "solid", borderWidth: "0 110px 76px 110px", borderColor: "transparent transparent #CBD5E1 transparent" }} /></div>;

    return null;
}

function NonCardEventEffect({ event, visualStyle }: { event?: VisualEventSpec; visualStyle: ResolvedVisualStyle }) {
    const frame = useCurrentFrame();
    const type = event?.type ?? "none";
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;

    switch (type) {
        case "alarm-pulse":
            return <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.35 + pulse * 0.18 }}><div style={{ position: "absolute", left: 690, top: 220, width: 540, height: 540, borderRadius: 540, border: "10px solid rgba(255,70,70,0.38)", transform: `scale(${0.84 + pulse * 0.16})`, boxShadow: "0 0 70px rgba(255,80,80,0.25)" }} /></AbsoluteFill>;
        case "audience-silhouette":
            return <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.7 }}>{Array.from({ length: 7 }, (_, i) => <div key={i} style={{ position: "absolute", bottom: -70, left: 170 + i * 235, width: 125, height: 190 + (i % 2) * 34, borderRadius: "70px 70px 18px 18px", background: visualStyle.palette.shadow, filter: "blur(0.2px)" }} />)}</AbsoluteFill>;
        case "reaction-pop":
            return <div style={{ position: "absolute", left: 748, top: 150, width: 118, height: 118, borderRadius: 118, background: "rgba(255,255,255,0.42)", border: "10px solid rgba(37,99,235,0.50)", transform: `scale(${0.86 + pulse * 0.12})`, boxShadow: `0 16px 44px ${visualStyle.palette.shadow}`, zIndex: 5 }} />;
        case "none":
        case "screen-change":
        case "metaphor-cutaway":
        case "prop-tremble":
        case "thought-bubble":
        case "callback-card":
            return null;
        default:
            return assertNever(type);
    }
}

function VisualEventOverlay({ event, visualStyle, shotType }: { event?: VisualEventSpec; visualStyle: ResolvedVisualStyle; shotType: CartoonShotType }) {
    return <><NonCardEventEffect event={event} visualStyle={visualStyle} /><ForegroundPropOverlay prop={event?.foregroundProp} visualStyle={visualStyle} shotType={shotType} /></>;
}

function lightingOverlay(style: ResolvedVisualStyle): CSSProperties | null {
    switch (style.lighting) {
        case "neutral": return null;
        case "warm-window": return { background: "linear-gradient(105deg, rgba(255,219,153,0.24), transparent 44%)" };
        case "cool-monitor": return { background: "radial-gradient(circle at 58% 45%, rgba(56,189,248,0.24), transparent 34%)" };
        case "morning-soft": return { background: "linear-gradient(135deg, rgba(255,255,255,0.20), rgba(251,191,36,0.10), transparent 58%)" };
        default: return assertNever(style.lighting);
    }
}

function StyleFrame({ visualStyle, children }: { visualStyle: ResolvedVisualStyle; children: ReactNode }) {
    const lighting = lightingOverlay(visualStyle);
    return <>{children}{visualStyle.depth !== "flat" && <AbsoluteFill style={{ pointerEvents: "none", background: visualStyle.depth === "stage-depth" ? "radial-gradient(ellipse at 50% 95%, rgba(15,23,42,0.22), transparent 42%)" : "linear-gradient(180deg, transparent 62%, rgba(15,23,42,0.10))", zIndex: 4 }} />}{lighting && <AbsoluteFill style={{ pointerEvents: "none", ...lighting, opacity: 0.78, zIndex: 8 }} />}{visualStyle.shadow === "deep-stage" && <AbsoluteFill style={{ pointerEvents: "none", boxShadow: "inset 0 0 180px rgba(15,23,42,0.18)", zIndex: 9 }} />}</>;
}

function characterLayerTransform(shotType: CartoonShotType): string {
    switch (shotType) {
        case "wide": return "translateY(0px) scale(0.92)";
        case "medium": return "translateY(0px) scale(1)";
        case "close-up": return "translate(-54px, 42px) scale(1.10)";
        case "prop-close-up": return "translate(-140px, 74px) scale(0.93)";
        case "doorway-transition": return "translate(-70px, 20px) scale(1.02)";
        case "counter-shot": return "translate(-88px, 44px) scale(1.06)";
        case "table-shot": return "translate(-40px, 58px) scale(1.04)";
        default: return assertNever(shotType);
    }
}

export const CartoonScene = ({ background, mood = "neutral", characters, camera, visualEvent, speakerEmphasis = "scale-pop", shotType = "medium", visualStyle }: CartoonSceneProps) => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const scheme = getScheme(mood);
    const style = useMemo(() => resolveVisualStyle(visualStyle), [visualStyle]);
    const endFrame = Math.max(1, durationInFrames - 1);

    const zoomFrom = camera?.from ?? 1;
    const zoomTo = camera?.to ?? zoomFrom;
    const zoom = camera?.type === "zoom"
        ? interpolate(frame, [0, endFrame], [zoomFrom, zoomTo], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: cameraEasing })
        : 1;

    const panX = camera?.type === "pan"
        ? interpolate(frame, [0, endFrame], [camera.panFrom ?? 0, camera.panTo ?? 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: cameraEasing })
        : 0;

    const directedCharacters = useMemo(
        () => withConversationDirection(characters, speakerEmphasis),
        [characters, speakerEmphasis],
    );

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }}>
            <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "50% 50%" }}>
                <StyleFrame visualStyle={style}>
                    <Background background={background} panX={panX} />
                    <VisualEventOverlay event={visualEvent} visualStyle={style} shotType={shotType} />
                    <AbsoluteFill style={{ transform: `translateX(${panX}px) ${characterLayerTransform(shotType)}`, transformOrigin: "50% 78%" }}>
                        {directedCharacters.map((c, i) => <Character key={`${c.actorId ?? c.characterId}-${i}`} {...c} />)}
                    </AbsoluteFill>
                </StyleFrame>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
