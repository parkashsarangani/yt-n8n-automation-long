import { useMemo, type CSSProperties, type ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Background, BackgroundSpec } from "../components/Background";
import { Character, CharacterEmphasis, CharacterProps } from "../components/Character";
import { PropAsset } from "../components/PropAsset";
import { getScheme, Mood } from "../lib/colors";
import { composeCharactersForScene, foregroundMaskForScene } from "../lib/sceneComposition";
import {
    cinematicCameraStyle,
    cinematicCharacterLayerStyle,
    cinematicActingStageTransform,
    actingPresetFor,
    cinematicOverlayStyle,
    cinematicTransitionStyle,
    normalizedShotRecipe,
    propPlacementFor,
    shouldRenderPropAsBadge,
    type CinematicSceneSpec,
    type PhysicalPropPlacement,
} from "../lib/cinematicDirection";

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
    motion?: "none" | "pulse" | "glow" | "tremble" | "slide-away" | "thumb-hover" | "open" | "close" | "bounce" | "settle" | string;
    anchor?: "hand" | "table" | "foreground" | "background" | "left" | "right" | "center" | "counter" | "floor" | "wall" | string;
    placement?: PhysicalPropPlacement | string;
    renderMode?: "physical" | "badge" | string;
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
    cinematic?: CinematicSceneSpec;
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
            if (closest) directed = { ...directed, gazeX: closest.x >= character.x ? 6 : -6, gazeY: -0.5 };
        }

        return {
            ...directed,
            emphasis: character.isSpeaking ? emphasis : "none",
            dimmed: character.dimmed ?? (dimListeners && !character.isSpeaking),
        };
    });
}

function propHolder(characters: CharacterProps[]): CharacterProps | undefined {
    return characters.find((character) => character.isSpeaking) ?? characters[0];
}

function actorRigPoint(character: CharacterProps, side: "left" | "right", raised: boolean): { x: number; y: number } {
    const scale = Number.isFinite(character.scale) ? character.scale! : 1;
    const rigX = side === "right" ? (raised ? 382 : 349) : (raised ? 118 : 151);
    const rigY = raised ? 222 : 535;
    return {
        x: character.x + 250 + (rigX - 250) * scale,
        y: character.y + 700 + (rigY - 700) * scale,
    };
}

function handHeldSide(character: CharacterProps): "left" | "right" {
    return character.x < 720 ? "right" : "left";
}

function withPhysicalInteraction(
    characters: CharacterProps[],
    prop: ForegroundPropSpec | undefined,
    background: BackgroundSpec | undefined,
    cinematic: CinematicSceneSpec | undefined,
): CharacterProps[] {
    if (!prop?.type || prop.type === "none") return characters;
    if (propPlacementFor(background, prop, cinematic) !== "hand-held") return characters;
    const holder = propHolder(characters);
    if (!holder) return characters;
    const holderKey = holder.actorId ?? holder.characterId;
    const side = handHeldSide(holder);
    const preset = actingPresetFor(cinematic);
    return characters.map((character) => {
        const key = character.actorId ?? character.characterId;
        if (key !== holderKey) return character;
        const directedGesture = side === "right" ? "explain" : "point-left";
        return {
            ...character,
            gesture: directedGesture,
            gazeTarget: preset === "notices-prop" || preset === "payoff-freeze" ? "down" : character.gazeTarget,
            emphasis: character.emphasis === "none" ? "rim-glow" : character.emphasis,
        };
    });
}

function withCinematicRecipeBlocking(characters: CharacterProps[], cinematic?: CinematicSceneSpec): CharacterProps[] {
    if (!characters.length) return characters;
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    let activeIndex = characters.findIndex((character) => character.isSpeaking);
    if (activeIndex < 0) activeIndex = 0;

    return characters.map((character, index) => {
        const active = index === activeIndex;
        const baseScale = Number.isFinite(character.scale) ? character.scale! : 1;
        switch (recipe) {
            case "establishing":
                return { ...character, y: character.y + 58, scale: baseScale * 0.80 };
            case "reaction-closeup":
                return active
                    ? { ...character, x: 710, y: 138, scale: baseScale * 1.34, gazeTarget: "camera" }
                    : { ...character, x: index < activeIndex ? -250 : 1370, y: 252, scale: baseScale * 1.08, dimmed: true };
            case "prop-insert":
                return active
                    ? { ...character, x: 190, y: 300, scale: baseScale * 0.72, gazeTarget: "right" }
                    : { ...character, x: index < activeIndex ? -250 : 1390, y: 300, scale: baseScale * 0.68, dimmed: true };
            case "over-shoulder":
                return active
                    ? { ...character, x: 710, y: 205, scale: baseScale * 1.02, gazeTarget: activeIndex === 0 ? "right" : "left" }
                    : { ...character, x: index < activeIndex ? -130 : 1290, y: 238, scale: baseScale * 1.30, dimmed: true, gazeTarget: activeIndex === 0 ? "left" : "right" };
            case "payoff-hold":
                return active
                    ? { ...character, x: 700, y: 142, scale: baseScale * 1.22, gazeTarget: "camera" }
                    : { ...character, x: index < activeIndex ? -220 : 1360, y: 280, scale: baseScale * 0.80, dimmed: true };
            case "callback-reveal":
                return active
                    ? { ...character, x: 680, y: 170, scale: baseScale * 1.14, gazeTarget: "camera" }
                    : { ...character, x: index < activeIndex ? -180 : 1340, y: 270, scale: baseScale * 0.84, dimmed: true };
            case "crossing-transition":
            case "two-shot":
            default:
                return character;
        }
    });
}

function HandHeldPropOverlay({
    prop, characters, visualStyle, cinematic,
}: {
    prop?: ForegroundPropSpec;
    characters: CharacterProps[];
    visualStyle: ResolvedVisualStyle;
    cinematic?: CinematicSceneSpec;
}) {
    if (!prop?.type || prop.type === "none") return null;
    if (propPlacementFor(undefined, prop, cinematic) !== "hand-held") return null;
    const holder = propHolder(characters);
    if (!holder) return null;
    const side = handHeldSide(holder);
    const hand = actorRigPoint(holder, side, true);
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);
    const insert = recipe === "prop-insert";
    const directedProp: ForegroundPropSpec = { ...prop, placement: "hand-held", renderMode: "physical" };
    return (
        <div data-physical-interaction="actor-anchored-prop">
            <PropAsset
                prop={directedProp}
                x={insert ? 1030 : hand.x - 54}
                y={insert ? 250 : hand.y - 102}
                scale={(insert ? 1.85 : 0.64) * visualStyle.propScale}
                rotate={insert ? "-4deg" : (side === "right" ? "-10deg" : "10deg")}
                palette={visualStyle.palette}
                lineWeight={visualStyle.lineWeight}
                shadow={propShadow(visualStyle)}
                zIndex={8}
            />
        </div>
    );
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

function propShadow(style: ResolvedVisualStyle): string {
    switch (style.shadow) {
        case "none": return "none";
        case "soft-offset": return `0 16px 34px ${style.palette.shadow}`;
        case "deep-stage": return `0 24px 54px ${style.palette.shadow}`;
        default: return assertNever(style.shadow);
    }
}

function propAnchor(placement: PhysicalPropPlacement, background?: BackgroundSpec): { x: number; y: number; rotate: string } {
    const location = String(background?.location ?? "").toLowerCase();
    switch (placement) {
        case "hand-held": return { x: 805, y: 468, rotate: "-9deg" };
        case "on-table": return { x: 880, y: location === "office" ? 565 : 592, rotate: "2deg" };
        case "on-counter": return { x: 880, y: 575, rotate: "1deg" };
        case "floor": return { x: 870, y: 642, rotate: "0deg" };
        case "wall-mounted": return { x: 1040, y: 280, rotate: "0deg" };
        case "background-set-piece": return { x: 1080, y: 340, rotate: "0deg" };
        case "ui-badge": return { x: 930, y: 510, rotate: "0deg" };
    }
}

function shotOffset(shotType: CartoonShotType): { x: number; y: number; scale: number } {
    switch (shotType) {
        case "wide": return { x: -18, y: 8, scale: 0.74 };
        case "medium": return { x: 0, y: 0, scale: 1 };
        case "close-up": return { x: -54, y: 18, scale: 1.06 };
        case "prop-close-up": return { x: -260, y: -76, scale: 1.36 };
        case "doorway-transition": return { x: -92, y: -12, scale: 1.02 };
        case "counter-shot": return { x: -112, y: -38, scale: 1.14 };
        case "table-shot": return { x: -84, y: -52, scale: 1.10 };
        default: return assertNever(shotType);
    }
}

function propTransform(shotType: CartoonShotType, scale: number, rotate = "0deg"): string {
    const shot = shotOffset(shotType);
    return `rotate(${rotate}) scale(${scale * shot.scale})`;
}

function characterLayerTransform(shotType: CartoonShotType): string {
    switch (shotType) {
        case "wide": return "scale(0.94) translateY(10px)";
        case "medium": return "scale(1)";
        case "close-up": return "scale(1.08) translateY(10px)";
        case "prop-close-up": return "scale(0.90) translateY(20px)";
        case "doorway-transition": return "scale(1.00) translateY(8px)";
        case "counter-shot": return "scale(1.03) translateY(8px)";
        case "table-shot": return "scale(1.02) translateY(10px)";
        default: return assertNever(shotType);
    }
}

function ForegroundPropOverlay({ prop, visualStyle, shotType, background, cinematic }: { prop?: ForegroundPropSpec; visualStyle: ResolvedVisualStyle; shotType: CartoonShotType; background?: BackgroundSpec; cinematic?: CinematicSceneSpec }) {
    if (!prop?.type || prop.type === "none") return null;
    const placement = propPlacementFor(background, prop, cinematic);
    const anchor = propAnchor(placement, background);
    const shot = shotOffset(shotType);
    if (placement === "hand-held") return null;
    const badge = shouldRenderPropAsBadge(prop, placement, cinematic);
    const directedProp: ForegroundPropSpec = { ...prop, placement, renderMode: badge ? "badge" : "physical" };
    return (
        <PropAsset
            prop={directedProp}
            x={anchor.x + shot.x}
            y={anchor.y + shot.y}
            scale={visualStyle.propScale * shot.scale}
            rotate={anchor.rotate}
            palette={visualStyle.palette}
            lineWeight={visualStyle.lineWeight}
            shadow={propShadow(visualStyle)}
            zIndex={placement === "wall-mounted" || placement === "background-set-piece" ? 4 : 7}
        />
    );
}

function NonCardEventEffect({ event, visualStyle }: { event?: VisualEventSpec; visualStyle: ResolvedVisualStyle }) {
    const frame = useCurrentFrame();
    const pulse = 0.5 + Math.sin(frame / 8) * 0.5;
    const type: VisualEventType = event?.type ?? "none";
    switch (type) {
        case "none": return null;
        case "alarm-pulse":
            return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(circle at 78% 28%, ${visualStyle.palette.accent}55, transparent ${24 + pulse * 12}%)`, zIndex: 6 }} />;
        case "screen-change":
            return <AbsoluteFill style={{ pointerEvents: "none", background: `linear-gradient(90deg, transparent, ${visualStyle.palette.accent2}22, transparent)`, transform: `translateX(${Math.sin(frame / 18) * 30}px)`, zIndex: 6 }} />;
        case "audience-silhouette":
            return <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, transparent 62%, rgba(15,23,42,0.22) 100%)", zIndex: 6 }} />;
        case "metaphor-cutaway":
            return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(circle at 50% 45%, ${visualStyle.palette.surface}66, transparent 38%)`, opacity: 0.54, zIndex: 6 }} />;
        case "thought-bubble":
            return <AbsoluteFill style={{ pointerEvents: "none", background: "radial-gradient(circle at 70% 24%, rgba(255,255,255,0.72) 0 28px, transparent 30px), radial-gradient(circle at 63% 30%, rgba(255,255,255,0.46) 0 16px, transparent 18px)", opacity: 0.75, zIndex: 6 }} />;
        case "reaction-pop":
            return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(circle at 50% 40%, ${visualStyle.palette.accent}55 0 4px, transparent 5px), radial-gradient(circle at 58% 34%, ${visualStyle.palette.accent2}55 0 5px, transparent 6px)`, transform: `scale(${1 + pulse * 0.02})`, zIndex: 6 }} />;
        case "prop-tremble":
        case "callback-card":
            return null;
        default:
            return assertNever(type);
    }
}

function VisualEventOverlay({ event, visualStyle, shotType, background, cinematic }: { event?: VisualEventSpec; visualStyle: ResolvedVisualStyle; shotType: CartoonShotType; background?: BackgroundSpec; cinematic?: CinematicSceneSpec }) {
    return <><NonCardEventEffect event={event} visualStyle={visualStyle} /><ForegroundPropOverlay prop={event?.foregroundProp} visualStyle={visualStyle} shotType={shotType} background={background} cinematic={cinematic} /></>;
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

function foregroundMaskStyle(mask: ReturnType<typeof foregroundMaskForScene>, visualStyle: ResolvedVisualStyle): CSSProperties | null {
    switch (mask) {
        case undefined:
        case "none": return null;
        case "counter": return { left: 0, right: 0, bottom: -18, height: 138, background: `linear-gradient(180deg, ${visualStyle.palette.paper}, ${visualStyle.palette.surface})`, borderTop: `${visualStyle.lineWeight}px solid ${visualStyle.palette.outline}` };
        case "desk": return { left: 180, right: 160, bottom: -16, height: 126, borderRadius: "38px 38px 0 0", background: `linear-gradient(180deg, ${visualStyle.palette.surface}, ${visualStyle.palette.paper})`, border: `${visualStyle.lineWeight}px solid ${visualStyle.palette.outline}`, borderBottom: "none" };
        case "cafe-table": return { left: 260, right: 250, bottom: -24, height: 120, borderRadius: "80px 80px 0 0", background: "#92400E", borderTop: `${visualStyle.lineWeight}px solid #451A03` };
        case "shop-counter": return { left: 0, right: 0, bottom: -18, height: 130, background: "linear-gradient(180deg,#FCD34D,#F59E0B)", borderTop: `${visualStyle.lineWeight}px solid ${visualStyle.palette.outline}` };
        case "hospital-bed": return { right: 80, bottom: 18, width: 420, height: 96, borderRadius: "36px 36px 18px 18px", background: "rgba(219,234,254,0.96)", border: `${visualStyle.lineWeight}px solid rgba(30,58,138,0.38)` };
        case "car-dashboard": return { left: 0, right: 0, bottom: -8, height: 178, borderRadius: "48% 48% 0 0 / 32% 32% 0 0", background: "linear-gradient(180deg,#1E293B,#0F172A)", boxShadow: "0 -18px 42px rgba(15,23,42,0.22)" };
        default: return assertNever(mask);
    }
}

function ForegroundSceneMask({ background, visualStyle }: { background?: BackgroundSpec; visualStyle: ResolvedVisualStyle }) {
    const style = foregroundMaskStyle(foregroundMaskForScene(background), visualStyle);
    if (!style) return null;
    return <div style={{ position: "absolute", pointerEvents: "none", zIndex: 6, ...style }} />;
}

function CinematicAccent({ cinematic }: { cinematic?: CinematicSceneSpec }) {
    const style = cinematicOverlayStyle(cinematic);
    if (!style) return null;
    return <AbsoluteFill style={{ pointerEvents: "none", zIndex: 9, ...style }} />;
}

function StyleFrame({ visualStyle, children }: { visualStyle: ResolvedVisualStyle; children: ReactNode }) {
    const lighting = lightingOverlay(visualStyle);
    return <>{children}{visualStyle.depth !== "flat" && <AbsoluteFill style={{ pointerEvents: "none", background: visualStyle.depth === "stage-depth" ? "radial-gradient(ellipse at 50% 95%, rgba(15,23,42,0.22), transparent 42%)" : "linear-gradient(180deg, transparent 62%, rgba(15,23,42,0.10))", zIndex: 4 }} />}{lighting && <AbsoluteFill style={{ pointerEvents: "none", ...lighting, opacity: 0.78, zIndex: 8 }} />}{visualStyle.shadow === "deep-stage" && <AbsoluteFill style={{ pointerEvents: "none", boxShadow: "inset 0 0 180px rgba(15,23,42,0.18)", zIndex: 9 }} />}</>;
}

function combineTransforms(...transforms: Array<string | undefined>): string {
    return transforms.filter(Boolean).join(" ");
}

export const CartoonScene = ({ background, mood = "neutral", characters, camera, visualEvent, speakerEmphasis = "scale-pop", shotType = "medium", visualStyle, cinematic }: CartoonSceneProps) => {
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

    const stagedCharacters = useMemo(
        () => composeCharactersForScene(characters, background, shotType),
        [characters, background, shotType],
    );

    const recipeBlockedCharacters = useMemo(
        () => withCinematicRecipeBlocking(stagedCharacters, cinematic),
        [stagedCharacters, cinematic],
    );

    const directedCharacters = useMemo(
        () => withConversationDirection(recipeBlockedCharacters, speakerEmphasis),
        [recipeBlockedCharacters, speakerEmphasis],
    );
    const performedCharacters = useMemo(
        () => withPhysicalInteraction(directedCharacters, visualEvent?.foregroundProp, background, cinematic),
        [directedCharacters, visualEvent?.foregroundProp, background, cinematic],
    );

    const cinematicCamera = cinematicCameraStyle(cinematic, frame, durationInFrames);
    const cinematicTransition = cinematicTransitionStyle(cinematic, frame);
    const characterLayer = cinematicCharacterLayerStyle(cinematic);
    const actingStage = cinematicActingStageTransform(cinematic, frame, durationInFrames);
    const actingActor = performedCharacters.find((character) => character.isSpeaking) ?? performedCharacters[0];
    const actingActorKey = actingActor?.actorId ?? actingActor?.animationKey ?? actingActor?.characterId;
    const heldPropActor = propHolder(performedCharacters);
    const heldPropActorKey = heldPropActor?.actorId ?? heldPropActor?.animationKey ?? heldPropActor?.characterId;
    const recipe = normalizedShotRecipe(cinematic?.shotRecipe);

    return (
        <AbsoluteFill style={{ background: scheme.backgroundGradient, overflow: "hidden" }} data-shot-recipe={recipe}>
            <AbsoluteFill style={cinematicTransition}>
                <AbsoluteFill style={{ ...cinematicCamera, transform: combineTransforms(cinematicCamera.transform as string | undefined, `scale(${zoom})`), transformOrigin: cinematicCamera.transformOrigin ?? "50% 50%" }}>
                    <StyleFrame visualStyle={style}>
                        <Background background={background} panX={panX} />
                        <VisualEventOverlay event={visualEvent} visualStyle={style} shotType={shotType} background={background} cinematic={cinematic} />
                        <AbsoluteFill style={{ transform: combineTransforms(`translateX(${panX}px)`, characterLayerTransform(shotType)), ...characterLayer, zIndex: 5 }}>
                            {performedCharacters.map((c, i) => {
                                const key = c.actorId ?? c.animationKey ?? `${c.characterId}-${i}`;
                                const actorTransform = key === actingActorKey ? actingStage : undefined;
                                return (
                                    <AbsoluteFill key={key} data-acting-actor={key === actingActorKey ? "active" : "listener"} style={{ transform: actorTransform, pointerEvents: "none" }}>
                                        <Character {...c} />
                                    </AbsoluteFill>
                                );
                            })}
                            <AbsoluteFill data-held-prop-follows-actor="true" style={{ transform: heldPropActorKey === actingActorKey ? actingStage : undefined, pointerEvents: "none" }}>
                                <HandHeldPropOverlay prop={visualEvent?.foregroundProp} characters={performedCharacters} visualStyle={style} cinematic={cinematic} />
                            </AbsoluteFill>
                        </AbsoluteFill>
                        <ForegroundSceneMask background={background} visualStyle={style} />
                        <CinematicAccent cinematic={cinematic} />
                    </StyleFrame>
                </AbsoluteFill>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
