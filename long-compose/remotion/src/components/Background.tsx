import { AbsoluteFill, Img, staticFile } from "remotion";
import { EnvironmentTone, getEnvironmentEffect } from "../lib/environment";

export interface BackgroundLayers {
    back?: boolean;
    middle?: boolean;
    front?: boolean;
}

export interface BackgroundSpec {
    location?: string;
    variant?: string;
    tone?: EnvironmentTone;
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

const panWrapperStyle = (offsetX: number): React.CSSProperties => ({
    position: "absolute",
    inset: 0,
    transform: `translateX(${offsetX}px)`,
});

const overscanImgStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    transform: `scale(${OVERSCAN})`,
};

export const Background: React.FC<BackgroundProps> = ({ background, panX = 0 }) => {
    if (background?.flat) {
        return <AbsoluteFill style={{ backgroundColor: background.flat }} />;
    }

    if (!background?.location || !background?.variant) return null;

    const src = (layer: keyof BackgroundLayers) =>
        staticFile(`backgrounds/${background.location}/${background.variant}/${layer}.svg`);

    const effect = getEnvironmentEffect(background.tone);

    return (
        <AbsoluteFill style={{ overflow: "hidden" }}>
            {background.layers?.back && (
                <div style={panWrapperStyle(panX * PARALLAX.back)}>
                    <Img src={src("back")} style={overscanImgStyle} />
                </div>
            )}
            {background.layers?.middle && (
                <div style={panWrapperStyle(panX * PARALLAX.middle)}>
                    <Img src={src("middle")} style={overscanImgStyle} />
                </div>
            )}
            {background.layers?.front && (
                <div style={panWrapperStyle(panX * PARALLAX.front)}>
                    <Img src={src("front")} style={overscanImgStyle} />
                </div>
            )}

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
