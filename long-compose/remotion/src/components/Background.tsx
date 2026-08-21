import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { EnvironmentTone, getEnvironmentEffect } from "../lib/environment";

export interface BackgroundLayers {
    back?: boolean;
    middle?: boolean;
    front?: boolean;
}

export type AmbientMotion =
    | "none" | "subtle-parallax" | "window-light" | "monitor-glow" | "chart-wiggle"
    | "clock-tick" | "rain-window" | "dust-float";

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

function ambientOffset(layer: keyof BackgroundLayers, ambient: AmbientMotion, frame: number): { x: number; y: number } {
    if (ambient === "none") return { x: 0, y: 0 };
    const depth = PARALLAX[layer];
    const slow = Math.sin(frame / 95) * depth;
    const slower = Math.cos(frame / 131) * depth;
    switch (ambient) {
        case "chart-wiggle": return layer === "middle" ? { x: Math.sin(frame / 18) * 1.2, y: 0 } : { x: slow * 2, y: 0 };
        case "clock-tick": return layer === "front" && frame % 30 < 3 ? { x: 0.8, y: 0 } : { x: slow, y: 0 };
        case "rain-window": return { x: slow * 3, y: ((frame * depth) % 18) / 18 };
        case "dust-float": return { x: slow * 2, y: slower * 2 };
        case "window-light": return { x: slow * 1.5, y: slower * 0.8 };
        case "monitor-glow": return { x: slow, y: 0 };
        default: return { x: slow * 4, y: slower };
    }
}

function AmbientOverlay({ ambient, frame }: { ambient: AmbientMotion; frame: number }) {
    if (ambient === "none" || ambient === "subtle-parallax" || ambient === "chart-wiggle" || ambient === "clock-tick") return null;
    const pulse = 0.5 + Math.sin(frame / 38) * 0.5;

    if (ambient === "window-light") {
        return <AbsoluteFill style={{ background: "linear-gradient(105deg, rgba(255,245,205,0.16), transparent 42%)", opacity: 0.45 + pulse * 0.12 }} />;
    }
    if (ambient === "monitor-glow") {
        return <AbsoluteFill style={{ background: "radial-gradient(circle at 58% 46%, rgba(88,190,255,0.22), transparent 32%)", opacity: 0.35 + pulse * 0.16 }} />;
    }
    if (ambient === "rain-window") {
        return <AbsoluteFill style={{ background: "repeating-linear-gradient(105deg, rgba(180,220,255,0.13) 0 2px, transparent 2px 28px)", transform: `translateY(${frame % 28}px)`, opacity: 0.28 }} />;
    }
    if (ambient === "dust-float") {
        return <AbsoluteFill style={{ background: "radial-gradient(circle at 25% 28%, rgba(255,255,255,0.18) 0 2px, transparent 3px), radial-gradient(circle at 62% 40%, rgba(255,255,255,0.12) 0 2px, transparent 3px), radial-gradient(circle at 78% 68%, rgba(255,255,255,0.12) 0 2px, transparent 3px)", transform: `translate(${Math.sin(frame / 70) * 8}px, ${Math.cos(frame / 91) * 5}px)`, opacity: 0.5 }} />;
    }
    return null;
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
    const layerStyleFor = (layer: keyof BackgroundLayers) => {
        const offset = ambientOffset(layer, ambient, frame);
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
