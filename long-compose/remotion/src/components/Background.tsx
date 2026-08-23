import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { EnvironmentTone, getEnvironmentEffect } from "../lib/environment";

export interface BackgroundLayers {
    back?: boolean;
    middle?: boolean;
    front?: boolean;
}

export type AmbientMotion =
    | "none" | "subtle-parallax" | "window-light" | "monitor-glow" | "chart-wiggle"
    | "clock-tick" | "rain-window" | "dust-float" | "doorway-cross";

export interface BackgroundSpec {
    location?: string;
    variant?: string;
    tone?: EnvironmentTone;
    ambientMotion?: AmbientMotion;
    /** Resolved server-side (compose.js checks the filesystem) — which of back/middle/front exist for this location/variant. */
    layers?: BackgroundLayers;
    /** Hex color. When set, skips location/variant/layers entirely — a solid card for punchlines/reactions. */
    flat?: string;
}

export interface BackgroundProps {
    background?: BackgroundSpec;
    /** Horizontal camera offset (px) at the current frame — drives parallax. 0 when the camera isn't panning. */
    panX?: number;
}

interface AmbientFrameMath {
    slow: number;
    slower: number;
    chart: number;
    tick: boolean;
    rain: number;
}

// Layers move at different fractions of the camera pan — distant layers
// shift less than near ones, the standard cheap-parallax trick.
const PARALLAX = { back: 0.2, middle: 0.55, front: 1.0 };

// Every background layer is drawn at viewBox="0 0 1920 1080" — exactly the
// output frame, no hand-authored margin. A pan would reveal a hard edge at
// that native size, so the safety margin lives here instead: each layer is
// scaled up slightly and only then panned, which is more robust than relying
// on generated art to leave an exact overscan border. At OVERSCAN=1.15 a
// 1920-wide layer becomes ~2208px, giving ~144px of pan budget per side —
// keep camera.panFrom/panTo within roughly ±120px to stay inside it.
const OVERSCAN = 1.15;

const panWrapperStyle = (offsetX: number, offsetY = 0): React.CSSProperties => ({
    position: "absolute",
    inset: 0,
    transform: `translate(${offsetX}px, ${offsetY}px)`,
});

const overscanImgStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    transform: `scale(${OVERSCAN})`,
};

function assertNever(value: never): never {
    throw new Error(`Unhandled ambient motion value: ${value}`);
}

function ambientOffset(layer: keyof BackgroundLayers, ambient: AmbientMotion, base: AmbientFrameMath): { x: number; y: number } {
    const depth = PARALLAX[layer];
    const slow = base.slow * depth;
    const slower = base.slower * depth;
    switch (ambient) {
        case "none": return { x: 0, y: 0 };
        case "chart-wiggle": return layer === "middle" ? { x: base.chart * 1.2, y: 0 } : { x: slow * 2, y: 0 };
        case "clock-tick": return layer === "front" && base.tick ? { x: 0.8, y: 0 } : { x: slow, y: 0 };
        case "rain-window": return { x: slow * 3, y: base.rain * depth };
        case "dust-float": return { x: slow * 2, y: slower * 2 };
        case "window-light": return { x: slow * 1.5, y: slower * 0.8 };
        case "monitor-glow": return { x: slow, y: 0 };
        case "subtle-parallax": return { x: slow * 4, y: slower };
        case "doorway-cross": return { x: slow * 5, y: slower * 1.2 };
        default: return assertNever(ambient);
    }
}

function DoorwayCrossOverlay({ frame }: { frame: number }) {
    const open = 0.5 + Math.sin(frame / 28) * 0.5;
    return (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
            <div
                style={{
                    position: "absolute",
                    left: 104,
                    top: 86,
                    width: 260,
                    height: 538,
                    borderRadius: "18px 18px 8px 8px",
                    background: "linear-gradient(90deg, rgba(69,26,3,0.92), rgba(120,53,15,0.88))",
                    boxShadow: "0 22px 48px rgba(69,26,3,0.20)",
                }}
            />
            <div
                style={{
                    position: "absolute",
                    left: 154,
                    top: 122,
                    width: 168 + open * 20,
                    height: 466,
                    borderRadius: "10px 10px 4px 4px",
                    background: "linear-gradient(180deg, rgba(255,247,237,0.72), rgba(186,230,253,0.42))",
                    boxShadow: "inset 0 0 64px rgba(255,255,255,0.34)",
                }}
            />
            <div
                style={{
                    position: "absolute",
                    left: 332,
                    top: 118,
                    width: 42,
                    height: 482,
                    borderRadius: "8px",
                    background: "#78350F",
                    transform: `translateX(${open * 18}px) rotateY(${12 + open * 5}deg)`,
                    transformOrigin: "left center",
                    boxShadow: "0 18px 32px rgba(69,26,3,0.22)",
                }}
            />
            <div
                style={{
                    position: "absolute",
                    left: 380,
                    top: 70,
                    width: 480,
                    height: 580,
                    background: "linear-gradient(90deg, rgba(255,255,255,0.12), transparent 62%)",
                    opacity: 0.35 + open * 0.16,
                    clipPath: "polygon(0 14%, 100% 0, 100% 100%, 0 78%)",
                }}
            />
        </AbsoluteFill>
    );
}

function AmbientOverlay({ ambient, frame }: { ambient: AmbientMotion; frame: number }) {
    const pulse = 0.5 + Math.sin(frame / 38) * 0.5;
    switch (ambient) {
        case "none":
        case "subtle-parallax":
        case "chart-wiggle":
        case "clock-tick":
            return null;
        case "doorway-cross":
            return <DoorwayCrossOverlay frame={frame} />;
        case "window-light":
            return <AbsoluteFill style={{ background: "linear-gradient(105deg, rgba(255,245,205,0.16), transparent 42%)", opacity: 0.45 + pulse * 0.12 }} />;
        case "monitor-glow":
            return <AbsoluteFill style={{ background: "radial-gradient(circle at 58% 46%, rgba(88,190,255,0.22), transparent 32%)", opacity: 0.35 + pulse * 0.16 }} />;
        case "rain-window":
            return <AbsoluteFill style={{ background: "repeating-linear-gradient(105deg, rgba(180,220,255,0.13) 0 2px, transparent 2px 28px)", transform: `translateY(${frame % 28}px)`, opacity: 0.28 }} />;
        case "dust-float":
            return <AbsoluteFill style={{ background: "radial-gradient(circle at 25% 28%, rgba(255,255,255,0.18) 0 2px, transparent 3px), radial-gradient(circle at 62% 40%, rgba(255,255,255,0.12) 0 2px, transparent 3px), radial-gradient(circle at 78% 68%, rgba(255,255,255,0.12) 0 2px, transparent 3px)", transform: `translate(${Math.sin(frame / 70) * 8}px, ${Math.cos(frame / 91) * 5}px)`, opacity: 0.5 }} />;
        default:
            return assertNever(ambient);
    }
}

export const Background: React.FC<BackgroundProps> = ({ background, panX = 0 }) => {
    const frame = useCurrentFrame();
    if (background?.flat) {
        return <AbsoluteFill style={{ backgroundColor: background.flat }} />;
    }

    if (!background?.location || !background?.variant) return null;

    const src = (layer: keyof BackgroundLayers) =>
        staticFile(`backgrounds/${background.location}/${background.variant}/${layer}.svg`);

    const effect = getEnvironmentEffect(background.tone);
    const ambient = background.ambientMotion ?? "none";
    const ambientBase: AmbientFrameMath = {
        slow: Math.sin(frame / 95),
        slower: Math.cos(frame / 131),
        chart: Math.sin(frame / 18),
        tick: frame % 30 < 3,
        rain: (frame % 18) / 18,
    };
    const layerStyleFor = (layer: keyof BackgroundLayers) => {
        const offset = ambientOffset(layer, ambient, ambientBase);
        return panWrapperStyle(panX * PARALLAX[layer] + offset.x, offset.y);
    };

    return (
        <AbsoluteFill style={{ overflow: "hidden" }}>
            {background.layers?.back && (
                <div style={layerStyleFor("back")}>
                    <Img src={src("back")} style={overscanImgStyle} />
                </div>
            )}
            {background.layers?.middle && (
                <div style={layerStyleFor("middle")}>
                    <Img src={src("middle")} style={overscanImgStyle} />
                </div>
            )}
            {background.layers?.front && (
                <div style={layerStyleFor("front")}>
                    <Img src={src("front")} style={overscanImgStyle} />
                </div>
            )}

            <AmbientOverlay ambient={ambient} frame={frame} />

            {effect.fog > 0 && (
                <AbsoluteFill
                    style={{
                        background: "radial-gradient(ellipse at 50% 65%, rgba(255,255,255,0.7), transparent 70%)",
                        opacity: effect.fog,
                    }}
                />
            )}
            {effect.tint !== "rgba(0,0,0,0)" && <AbsoluteFill style={{ background: effect.tint }} />}
            {effect.vignette > 0 && (
                <AbsoluteFill style={{ boxShadow: `inset 0 0 260px rgba(0,0,0,${effect.vignette})` }} />
            )}
        </AbsoluteFill>
    );
};
