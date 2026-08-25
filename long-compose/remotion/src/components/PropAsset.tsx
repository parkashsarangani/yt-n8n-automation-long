import type { CSSProperties } from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { renderableLocalAsset, resolvePropAsset } from "../lib/assetRegistry";
import { propPlacementFor, shouldRenderPropAsBadge, type PhysicalPropPlacement } from "../lib/cinematicDirection";

export interface PropAssetSpec {
    type?: string;
    state?: string;
    motion?: string;
    anchor?: string;
    placement?: PhysicalPropPlacement | string;
    renderMode?: "physical" | "badge" | string;
    label?: string;
}

export interface PropAssetPalette {
    outline: string;
    paper: string;
    accent: string;
    accent2: string;
    surface: string;
    shadow: string;
}

export interface PropAssetProps {
    prop?: PropAssetSpec;
    x: number;
    y: number;
    scale: number;
    rotate?: string;
    palette: PropAssetPalette;
    lineWeight: number;
    shadow: string;
    zIndex?: number;
}

export const FALLBACK_GLYPH_BY_TYPE: Record<string, string> = {
    phone: "▯",
    cellphone: "▯",
    charger: "ϟ",
    "phone-charger": "ϟ",
    clock: "◷",
    "alarm clock": "◷",
    keys: "⚿",
    key: "⚿",
    "route-map": "⌁",
    map: "⌁",
    calendar: "▦",
    door: "▭",
    doorway: "▭",
    coffee: "☕",
    mug: "☕",
    shoes: "⌯",
    shoe: "⌯",
    laptop: "▰",
    computer: "▰",
    bed: "▱",
    sheets: "▱",
    window: "▢",
    kettle: "♨",
    food: "◒",
    document: "▤",
    file: "▤",
    bill: "▧",
    letter: "✉",
    locker: "▥",
    cabinet: "▥",
    vehicle: "◖",
    car: "◖",
    tool: "◆",
    appliance: "◉",
    device: "◎",
};

function motionTransform(motion: string, frame: number): { x: number; y: number; scale: number; opacity: number } {
    const normalized = motion.toLowerCase();
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;
    return {
        x: normalized === "tremble" ? Math.sin(frame * 1.7) * 4 : normalized === "slide-away" ? interpolate(Math.min(frame, 24), [0, 24], [0, 120], { extrapolateRight: "clamp" }) : 0,
        y: normalized === "bounce" || normalized === "thumb-hover" ? Math.sin(frame / 5) * 7 : normalized === "settle" ? interpolate(Math.min(frame, 10), [0, 10], [-18, 0], { extrapolateRight: "clamp" }) : 0,
        scale: normalized === "pulse" || normalized === "glow" || normalized === "bounce" ? 1 + pulse * 0.045 : 1,
        opacity: normalized === "glow" ? 0.96 : 1,
    };
}

function assetSize(type?: string, placement?: PhysicalPropPlacement): { width: number; height: number } {
    const normalized = String(type ?? "").toLowerCase();
    const placementScale = placement === "hand-held" ? 0.78 : placement === "wall-mounted" ? 0.92 : placement === "floor" ? 1.1 : 1;
    const base = (() => {
        switch (normalized) {
            case "laptop":
            case "computer":
            case "route-map":
            case "map": return { width: 250, height: 178 };
            case "document":
            case "letter":
            case "bill": return { width: 160, height: 200 };
            case "phone":
            case "charger":
            case "phone-charger": return { width: 132, height: 188 };
            case "car":
            case "vehicle": return { width: 280, height: 170 };
            case "shoes":
            case "shoe": return { width: 210, height: 120 };
            case "door":
            case "doorway": return { width: 190, height: 250 };
            case "window": return { width: 210, height: 180 };
            case "kettle":
            case "coffee":
            case "food": return { width: 170, height: 170 };
            default: return { width: 180, height: 180 };
        }
    })();
    return { width: Math.round(base.width * placementScale), height: Math.round(base.height * placementScale) };
}

function fallbackGlyph(type?: string): string {
    return FALLBACK_GLYPH_BY_TYPE[String(type ?? "").toLowerCase()] ?? "◇";
}

function physicalPlacementStyle(placement: PhysicalPropPlacement): CSSProperties {
    switch (placement) {
        case "hand-held": return { transformOrigin: "42% 82%" };
        case "on-table": return { transformOrigin: "50% 100%" };
        case "on-counter": return { transformOrigin: "50% 100%" };
        case "floor": return { transformOrigin: "50% 100%" };
        case "wall-mounted": return { transformOrigin: "50% 50%" };
        case "background-set-piece": return { transformOrigin: "50% 100%" };
        case "ui-badge": return { transformOrigin: "50% 50%" };
    }
}

function propObjectShadow(placement: PhysicalPropPlacement, shadow: string): CSSProperties {
    if (placement === "wall-mounted") return { filter: "drop-shadow(0 10px 8px rgba(15,23,42,0.18))" };
    if (placement === "hand-held") return { filter: "drop-shadow(0 11px 10px rgba(15,23,42,0.26))" };
    return { filter: `drop-shadow(0 16px 12px rgba(15,23,42,0.24))`, boxShadow: shadow === "none" ? undefined : "0 18px 26px rgba(15,23,42,0.10)" };
}

/**
 * CartoonScene historically anchored hand-held props to the old raised-arm
 * palm coordinates. The richer present/point rigs put the palm materially
 * lower and farther outward, so the prop appeared beside the actor's ear.
 * The overlay already communicates side via its rotation: -10deg = right
 * hand, +10deg = left hand. Apply the visual delta from the legacy raised
 * palm to the current present/point palm here, keeping all other placements
 * unchanged. This is intentionally local to hand-held props and therefore
 * cannot shift table/counter/wall assets.
 */
function handHeldPalmOffset(rotate: string): { x: number; y: number } {
    const rightHand = String(rotate).trim().startsWith("-");
    return rightHand ? { x: 38, y: 140 } : { x: -48, y: 132 };
}

function badgeShellStyle(width: number, height: number, palette: PropAssetPalette, lineWeight: number, shadow: string, glow: boolean): CSSProperties {
    return {
        width,
        height,
        borderRadius: Math.min(30, Math.round(width * 0.15)),
        background: `linear-gradient(180deg, ${palette.paper}, ${palette.surface})`,
        border: `${Math.max(4, lineWeight - 2)}px solid ${palette.outline}`,
        boxShadow: glow ? `0 0 34px ${palette.accent2}66, ${shadow}` : shadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
    };
}

export function PropAsset({ prop, x, y, scale, rotate = "0deg", palette, lineWeight, shadow, zIndex = 7 }: PropAssetProps) {
    const frame = useCurrentFrame();
    if (!prop?.type || prop.type === "none") return null;

    const asset = resolvePropAsset(prop.type);
    const requestedPlacement = propPlacementFor(undefined, { type: prop.type, anchor: prop.placement ?? prop.anchor, state: prop.state, motion: prop.motion }, undefined);
    const placement = prop.placement ? requestedPlacement : propPlacementFor(undefined, prop, undefined);
    const badge = prop.renderMode === "badge" || shouldRenderPropAsBadge(prop, placement, { propMode: prop.renderMode });
    const motion = motionTransform(String(prop.motion ?? "none"), frame);
    const { width, height } = assetSize(prop.type, placement);
    const glow = /glow|notification|unlocked|late|urgent|open|on|running/.test(String(prop.state ?? "").toLowerCase()) || String(prop.motion ?? "").toLowerCase() === "glow";
    const transform = `translate(${motion.x}px, ${motion.y}px) rotate(${rotate}) scale(${scale * motion.scale})`;
    const placementStyle = physicalPlacementStyle(placement);
    const palmOffset = placement === "hand-held" ? handHeldPalmOffset(rotate) : { x: 0, y: 0 };
    const base: CSSProperties = {
        position: "absolute",
        left: x + palmOffset.x,
        top: y + palmOffset.y,
        width,
        height,
        zIndex,
        transform,
        ...placementStyle,
        opacity: motion.opacity,
        pointerEvents: "none",
    };

    const content = renderableLocalAsset(asset)
        ? <Img src={staticFile(asset.source.path)} style={{ width: "100%", height: "100%", objectFit: "contain", filter: glow ? "drop-shadow(0 0 10px rgba(255,255,255,0.55))" : undefined }} />
        : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: palette.accent, fontWeight: 900, fontSize: Math.round(Math.min(width, height) * 0.55), lineHeight: 1 }}>{fallbackGlyph(prop.type)}</div>;

    if (badge) {
        return (
            <div style={base} data-prop-asset={asset?.key ?? "fallback-glyph"} data-prop-mode="badge">
                <div style={badgeShellStyle(width, height, palette, lineWeight, shadow, glow)}>
                    <div style={{ width: "70%", height: "70%", display: "flex", alignItems: "center", justifyContent: "center" }}>{content}</div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ ...base, ...propObjectShadow(placement, shadow) }} data-prop-asset={asset?.key ?? "fallback-glyph"} data-prop-mode="physical" data-prop-placement={placement}>
            {content}
            {placement !== "wall-mounted" && placement !== "hand-held" && (
                <div style={{ position: "absolute", left: "18%", right: "18%", bottom: -8, height: 18, borderRadius: "50%", background: "rgba(15,23,42,0.16)", filter: "blur(6px)", zIndex: -1 }} />
            )}
        </div>
    );
}
