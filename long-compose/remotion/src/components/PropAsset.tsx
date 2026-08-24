import type { CSSProperties } from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { renderableLocalAsset, resolvePropAsset } from "../lib/assetRegistry";

export interface PropAssetSpec {
    type?: string;
    state?: string;
    motion?: string;
    anchor?: string;
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

function motionTransform(motion: string, frame: number): { x: number; y: number; scale: number; opacity: number } {
    const normalized = motion.toLowerCase();
    const pulse = 0.5 + Math.sin(frame / 6) * 0.5;
    return {
        x: normalized === "tremble" ? Math.sin(frame * 1.7) * 5 : normalized === "slide-away" ? interpolate(Math.min(frame, 24), [0, 24], [0, 130], { extrapolateRight: "clamp" }) : 0,
        y: normalized === "bounce" || normalized === "thumb-hover" ? Math.sin(frame / 5) * 7 : 0,
        scale: normalized === "pulse" || normalized === "glow" || normalized === "bounce" ? 1 + pulse * 0.05 : 1,
        opacity: normalized === "glow" ? 0.94 : 1,
    };
}

function assetSize(type?: string): { width: number; height: number } {
    switch (String(type ?? "").toLowerCase()) {
        case "laptop":
        case "route-map":
        case "map":
            return { width: 260, height: 188 };
        case "document":
        case "letter":
        case "bill":
            return { width: 178, height: 210 };
        case "phone":
        case "charger":
        case "phone-charger":
            return { width: 156, height: 220 };
        case "car":
        case "vehicle":
            return { width: 260, height: 170 };
        default:
            return { width: 190, height: 190 };
    }
}

function fallbackGlyph(type?: string): string {
    switch (String(type ?? "").toLowerCase()) {
        case "window": return "▢";
        case "tool": return "◆";
        case "appliance":
        case "device": return "◉";
        default: return "●";
    }
}

export function PropAsset({ prop, x, y, scale, rotate = "0deg", palette, lineWeight, shadow, zIndex = 7 }: PropAssetProps) {
    const frame = useCurrentFrame();
    if (!prop?.type || prop.type === "none") return null;

    const asset = resolvePropAsset(prop.type);
    const motion = motionTransform(String(prop.motion ?? "none"), frame);
    const { width, height } = assetSize(prop.type);
    const glow = /glow|notification|unlocked|late|urgent|open|on|running/.test(String(prop.state ?? "").toLowerCase()) || String(prop.motion ?? "").toLowerCase() === "glow";
    const transform = `translate(${motion.x}px, ${motion.y}px) rotate(${rotate}) scale(${scale * motion.scale})`;
    const shell: CSSProperties = {
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        zIndex,
        transform,
        transformOrigin: "50% 70%",
        borderRadius: 28,
        background: `linear-gradient(180deg, ${palette.paper}, ${palette.surface})`,
        border: `${Math.max(4, lineWeight - 2)}px solid ${palette.outline}`,
        boxShadow: glow ? `0 0 34px ${palette.accent2}66, ${shadow}` : shadow,
        opacity: motion.opacity,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
    };

    if (renderableLocalAsset(asset)) {
        return (
            <div style={shell} data-prop-asset={asset.key}>
                <Img src={staticFile(asset.source.path)} style={{ width: "72%", height: "72%", objectFit: "contain", filter: glow ? "drop-shadow(0 0 10px rgba(255,255,255,0.5))" : undefined }} />
            </div>
        );
    }

    return (
        <div style={shell} data-prop-asset="fallback-glyph">
            <div style={{ fontSize: Math.round(Math.min(width, height) * 0.52), lineHeight: 1, color: palette.accent, fontWeight: 800 }}>
                {fallbackGlyph(prop.type)}
            </div>
        </div>
    );
}
