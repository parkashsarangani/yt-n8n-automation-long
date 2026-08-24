import type { CSSProperties } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { assetByKey, renderableLocalAsset, resolveScenePlate, resolveSetPieceAsset, type RegisteredAsset } from "../lib/assetRegistry";
import { EnvironmentTone, getEnvironmentEffect } from "../lib/environment";
import { SceneDressing } from "./SceneDressing";

export interface BackgroundLayers {
    back?: boolean;
    middle?: boolean;
    front?: boolean;
}

export type AmbientMotion =
    | "none" | "subtle-parallax" | "window-light" | "monitor-glow" | "chart-wiggle"
    | "clock-tick" | "rain-window" | "dust-float" | "doorway-cross";

export type BackgroundSetPieceKind = "doorway" | "window" | "bed" | "locker" | "vehicle";

export interface BackgroundSetPiece {
    kind?: BackgroundSetPieceKind;
    motion?: "still" | "cross" | "glow" | "settle";
    emphasis?: "low" | "medium" | "high";
    assetKey?: string;
}

export interface BackgroundScenePlate {
    assetKey?: string;
    enabled?: boolean;
}

export interface BackgroundSpec {
    location?: string;
    variant?: string;
    tone?: EnvironmentTone;
    ambientMotion?: AmbientMotion;
    scenePlate?: BackgroundScenePlate;
    setPiece?: BackgroundSetPiece;
    /** Backwards-compatible flag from compiler v14 doorway staging. Prefer `setPiece.kind = "doorway"`. */
    doorwaySetPiece?: boolean;
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

const PARALLAX = { back: 0.2, middle: 0.55, front: 1.0 };
const OVERSCAN = 1.15;

const panWrapperStyle = (offsetX: number, offsetY = 0): CSSProperties => ({
    position: "absolute",
    inset: 0,
    transform: `translate(${offsetX}px, ${offsetY}px)`,
});

const overscanImgStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    transform: `scale(${OVERSCAN})`,
};

const scenePlateStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
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

function scenePlateFor(background: BackgroundSpec): RegisteredAsset | undefined {
    if (background.scenePlate?.enabled === false) return undefined;
    const explicit = assetByKey(background.scenePlate?.assetKey);
    if (explicit?.role === "scenePlate") return explicit;
    return resolveScenePlate({ location: background.location, variant: background.variant });
}

function ScenePlate({ asset }: { asset?: RegisteredAsset }) {
    if (!renderableLocalAsset(asset) || asset.role !== "scenePlate") return null;
    return <Img src={staticFile(asset.source.path)} style={scenePlateStyle} />;
}

function DoorwaySetPiece({ frame }: { frame: number }) {
    const open = 0.5 + Math.sin(frame / 28) * 0.5;
    return (
        <>
            <div style={{ position: "absolute", left: 104, top: 86, width: 260, height: 538, borderRadius: "18px 18px 8px 8px", background: "linear-gradient(90deg, rgba(69,26,3,0.92), rgba(120,53,15,0.88))", boxShadow: "0 22px 48px rgba(69,26,3,0.20)" }} />
            <div style={{ position: "absolute", left: 154, top: 122, width: 168 + open * 20, height: 466, borderRadius: "10px 10px 4px 4px", background: "linear-gradient(180deg, rgba(255,247,237,0.72), rgba(186,230,253,0.42))", boxShadow: "inset 0 0 64px rgba(255,255,255,0.34)" }} />
            <div style={{ position: "absolute", left: 332, top: 118, width: 42, height: 482, borderRadius: "8px", background: "#78350F", transform: `translateX(${open * 18}px) rotateY(${12 + open * 5}deg)`, transformOrigin: "left center", boxShadow: "0 18px 32px rgba(69,26,3,0.22)" }} />
            <div style={{ position: "absolute", left: 380, top: 70, width: 480, height: 580, background: "linear-gradient(90deg, rgba(255,255,255,0.12), transparent 62%)", opacity: 0.35 + open * 0.16, clipPath: "polygon(0 14%, 100% 0, 100% 100%, 0 78%)" }} />
        </>
    );
}

function WindowSetPiece({ frame }: { frame: number }) {
    const glow = 0.5 + Math.sin(frame / 42) * 0.5;
    return <div style={{ position: "absolute", left: 105, top: 92, width: 300, height: 260, borderRadius: 22, background: "linear-gradient(180deg, rgba(186,230,253,0.86), rgba(253,230,138,0.52))", border: "14px solid rgba(255,255,255,0.78)", boxShadow: `0 18px 50px rgba(251,191,36,${0.14 + glow * 0.08})` }}><div style={{ position: "absolute", left: 132, top: 0, width: 14, height: 260, background: "rgba(255,255,255,0.78)" }} /><div style={{ position: "absolute", left: 0, top: 116, width: 300, height: 14, background: "rgba(255,255,255,0.78)" }} /></div>;
}

function BedSetPiece() {
    return <div style={{ position: "absolute", right: 118, bottom: 74, width: 460, height: 170 }}><div style={{ position: "absolute", left: 0, top: 72, width: 460, height: 86, borderRadius: "34px 34px 18px 18px", background: "rgba(147,197,253,0.92)", border: "10px solid rgba(15,23,42,0.22)", boxShadow: "0 20px 44px rgba(15,23,42,0.16)" }} /><div style={{ position: "absolute", left: 28, top: 28, width: 144, height: 68, borderRadius: 22, background: "rgba(255,255,255,0.86)", border: "7px solid rgba(15,23,42,0.14)" }} /></div>;
}

function LockerSetPiece({ frame, motion }: { frame: number; motion?: string }) {
    const pulse = motion === "glow" ? 0.5 + Math.sin(frame / 20) * 0.5 : 0;
    return <div style={{ position: "absolute", right: 126, top: 122, width: 210, height: 430, borderRadius: 18, background: "#64748B", border: "12px solid #1E293B", boxShadow: motion === "glow" ? `0 0 ${26 + pulse * 26}px rgba(56,189,248,0.36)` : "0 20px 46px rgba(15,23,42,0.18)" }}><div style={{ position: "absolute", left: 0, top: 206, width: 210, height: 10, background: "#1E293B" }} /><div style={{ position: "absolute", right: 20, top: 92, width: 16, height: 16, borderRadius: 16, background: "#FACC15" }} /><div style={{ position: "absolute", right: 20, top: 310, width: 16, height: 16, borderRadius: 16, background: "#FACC15" }} /></div>;
}

function VehicleSetPiece() {
    return <div style={{ position: "absolute", left: 106, bottom: 82, width: 420, height: 168 }}><div style={{ position: "absolute", left: 34, top: 48, width: 350, height: 86, borderRadius: "34px 34px 18px 18px", background: "rgba(56,189,248,0.88)", boxShadow: "0 18px 42px rgba(15,23,42,0.18)" }} /><div style={{ position: "absolute", left: 126, top: 10, width: 170, height: 58, borderRadius: "24px 24px 0 0", background: "rgba(147,197,253,0.92)", border: "8px solid rgba(30,58,138,0.62)" }} /><div style={{ position: "absolute", left: 72, top: 114, width: 66, height: 66, borderRadius: 66, background: "#1E293B", border: "8px solid #475569" }} /><div style={{ position: "absolute", right: 72, top: 114, width: 66, height: 66, borderRadius: 66, background: "#1E293B", border: "8px solid #475569" }} /></div>;
}

function LocalSetPieceAsset({ asset }: { asset?: RegisteredAsset }) {
    if (!renderableLocalAsset(asset) || asset.source.kind !== "local-svg") return null;
    return <Img src={staticFile(asset.source.path)} style={{ position: "absolute", left: 86, top: 70, width: asset.width ?? 420, height: asset.height ?? 620, objectFit: "contain" }} />;
}

function SetPieceFallback({ kind, frame, motion }: { kind: BackgroundSetPieceKind; frame: number; motion?: string }) {
    switch (kind) {
        case "doorway": return <DoorwaySetPiece frame={frame} />;
        case "window": return <WindowSetPiece frame={frame} />;
        case "bed": return <BedSetPiece />;
        case "locker": return <LockerSetPiece frame={frame} motion={motion} />;
        case "vehicle": return <VehicleSetPiece />;
        default: return assertNever(kind);
    }
}

function SetPieceOverlay({ setPiece, frame }: { setPiece?: BackgroundSetPiece; frame: number }) {
    if (!setPiece?.kind) return null;
    const asset = assetByKey(setPiece.assetKey) ?? resolveSetPieceAsset(setPiece.kind);
    return (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
            {asset ? <LocalSetPieceAsset asset={asset} /> : <SetPieceFallback kind={setPiece.kind} frame={frame} motion={setPiece.motion} />}
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
            return <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(90deg, rgba(255,255,255,0.10), transparent 50%)", opacity: 0.35 + pulse * 0.12 }} />;
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

function BackgroundLayersView({ background, panX, ambientBase, ambient }: { background: BackgroundSpec; panX: number; ambientBase: AmbientFrameMath; ambient: AmbientMotion }) {
    if (!background.location || !background.variant) return null;
    const src = (layer: keyof BackgroundLayers) => staticFile(`backgrounds/${background.location}/${background.variant}/${layer}.svg`);
    const layerStyleFor = (layer: keyof BackgroundLayers) => {
        const offset = ambientOffset(layer, ambient, ambientBase);
        return panWrapperStyle(panX * PARALLAX[layer] + offset.x, offset.y);
    };
    return (
        <>
            {background.layers?.back && <div style={layerStyleFor("back")}><Img src={src("back")} style={overscanImgStyle} /></div>}
            {background.layers?.middle && <div style={layerStyleFor("middle")}><Img src={src("middle")} style={overscanImgStyle} /></div>}
            {background.layers?.front && <div style={layerStyleFor("front")}><Img src={src("front")} style={overscanImgStyle} /></div>}
        </>
    );
}

export const Background = ({ background, panX = 0 }: BackgroundProps) => {
    const frame = useCurrentFrame();
    if (background?.flat) return <AbsoluteFill style={{ backgroundColor: background.flat }} />;
    if (!background?.location || !background?.variant) return null;

    const effect = getEnvironmentEffect(background.tone);
    const ambient = background.ambientMotion ?? "none";
    const setPiece = background.setPiece ?? (background.doorwaySetPiece ? { kind: "doorway" as const, motion: "cross" as const } : undefined);
    const scenePlate = scenePlateFor(background);
    const replaceLayers = scenePlate?.compositeMode === "replace-background";
    const ambientBase: AmbientFrameMath = {
        slow: Math.sin(frame / 95),
        slower: Math.cos(frame / 131),
        chart: Math.sin(frame / 18),
        tick: frame % 30 < 3,
        rain: (frame % 18) / 18,
    };

    return (
        <AbsoluteFill style={{ overflow: "hidden" }}>
            <ScenePlate asset={scenePlate} />
            <SceneDressing background={background} frame={frame} />
            {!replaceLayers && <BackgroundLayersView background={background} panX={panX} ambientBase={ambientBase} ambient={ambient} />}
            <SetPieceOverlay setPiece={setPiece} frame={frame} />
            <AmbientOverlay ambient={ambient} frame={frame} />
            {effect.fog > 0 && <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 65%, rgba(255,255,255,0.7), transparent 70%)", opacity: effect.fog }} />}
            {effect.tint !== "rgba(0,0,0,0)" && <AbsoluteFill style={{ background: effect.tint }} />}
            {effect.vignette > 0 && <AbsoluteFill style={{ boxShadow: `inset 0 0 260px rgba(0,0,0,${effect.vignette})` }} />}
        </AbsoluteFill>
    );
};
