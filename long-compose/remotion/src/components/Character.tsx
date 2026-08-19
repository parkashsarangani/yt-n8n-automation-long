import { Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { mouthAtTime, MouthCue } from "../animation/lipsync";

// Current production rigs share this canvas. The next rig-contract revision can
// read dimensions from manifest.json without changing the acting API introduced here.
const RIG_WIDTH = 500;
const RIG_HEIGHT = 700;

export type ArmPose = "up" | "down";
export type Expression = "normal" | "angry" | "surprised";
const VALID_EXPRESSIONS = new Set<Expression>(["normal", "angry", "surprised"]);
export type SemanticEmotion =
    | "neutral"
    | "happy"
    | "amused"
    | "skeptical"
    | "confused"
    | "concerned"
    | "sad"
    | "angry"
    | "surprised"
    | "scared"
    | "thinking"
    | "annoyed";

export type Gesture =
    | "idle"
    | "explain"
    | "point-left"
    | "point-right"
    | "shrug"
    | "hands-open"
    | "surprised"
    | "thinking"
    | "facepalm"
    | "celebrate";

export type GazeTarget = "auto" | "camera" | "left" | "right" | "up" | "down" | "away";

export interface CharacterProps {
    characterId: string;
    actorId?: string;
    x: number;
    y: number;
    scale?: number;
    emotion?: SemanticEmotion;
    gesture?: Gesture;
    gazeTarget?: GazeTarget;
    leftArm?: ArmPose;
    rightArm?: ArmPose;
    expression?: Expression;
    isSpeaking?: boolean;
    mouthCues?: MouthCue[];
    gazeX?: number;
    gazeY?: number;
    /** @deprecated Prefer actorId. */
    animationKey?: string;
}

const layerStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: RIG_WIDTH,
    height: RIG_HEIGHT,
};

function stablePhase(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const EMOTION: Record<SemanticEmotion, {
    brow: Expression;
    eye: number;
    headTilt: number;
    bodyLean: number;
    gazeY: number;
    listenerMotion: number;
}> = {
    neutral:    { brow: "normal",    eye: 1.00, headTilt: 0.0,  bodyLean: 0.0,  gazeY: 0,  listenerMotion: 0.45 },
    happy:      { brow: "normal",    eye: 0.90, headTilt: -1.0, bodyLean: -0.4, gazeY: -1, listenerMotion: 0.75 },
    amused:     { brow: "normal",    eye: 0.78, headTilt: -2.0, bodyLean: -0.3, gazeY: -1, listenerMotion: 0.55 },
    skeptical:  { brow: "angry",     eye: 0.72, headTilt: 2.8,  bodyLean: 0.7,  gazeY: -1, listenerMotion: 0.25 },
    confused:   { brow: "surprised", eye: 0.92, headTilt: 3.2,  bodyLean: 0.2,  gazeY: 0,  listenerMotion: 0.50 },
    concerned:  { brow: "normal",    eye: 0.88, headTilt: -1.8, bodyLean: -0.6, gazeY: 1,  listenerMotion: 0.35 },
    sad:        { brow: "normal",    eye: 0.72, headTilt: 2.0,  bodyLean: 0.9,  gazeY: 2,  listenerMotion: 0.20 },
    angry:      { brow: "angry",     eye: 0.82, headTilt: -1.2, bodyLean: -1.0, gazeY: 0,  listenerMotion: 0.55 },
    surprised:  { brow: "surprised", eye: 1.14, headTilt: -2.2, bodyLean: -1.1, gazeY: -1, listenerMotion: 0.85 },
    scared:     { brow: "surprised", eye: 1.20, headTilt: -3.0, bodyLean: 1.6,  gazeY: -1, listenerMotion: 0.95 },
    thinking:   { brow: "normal",    eye: 0.78, headTilt: 3.0,  bodyLean: 0.5,  gazeY: 2,  listenerMotion: 0.20 },
    annoyed:    { brow: "angry",     eye: 0.64, headTilt: 2.0,  bodyLean: 0.8,  gazeY: 0,  listenerMotion: 0.20 },
};

const GESTURE: Record<Gesture, {
    left: ArmPose;
    right: ArmPose;
    bodyRotate: number;
    bodyY: number;
    scale: number;
    headExtra: number;
}> = {
    idle:          { left: "down", right: "down", bodyRotate: 0.0,  bodyY: 0,   scale: 1.000, headExtra: 0 },
    explain:       { left: "down", right: "up",   bodyRotate: -0.8, bodyY: -2,  scale: 1.003, headExtra: -0.6 },
    "point-left": { left: "up",   right: "down", bodyRotate: 0.8,  bodyY: -1,  scale: 1.002, headExtra: 0.8 },
    "point-right":{ left: "down", right: "up",   bodyRotate: -0.8, bodyY: -1,  scale: 1.002, headExtra: -0.8 },
    shrug:         { left: "up",   right: "up",   bodyRotate: 0.0,  bodyY: -5,  scale: 1.004, headExtra: 1.4 },
    "hands-open": { left: "up",   right: "up",   bodyRotate: 0.0,  bodyY: -3,  scale: 1.006, headExtra: -0.8 },
    surprised:     { left: "up",   right: "up",   bodyRotate: 0.0,  bodyY: -7,  scale: 1.015, headExtra: -1.2 },
    thinking:      { left: "down", right: "up",   bodyRotate: 1.0,  bodyY: 0,   scale: 1.000, headExtra: 2.0 },
    facepalm:      { left: "down", right: "up",   bodyRotate: -1.0, bodyY: 1,   scale: 0.998, headExtra: -3.0 },
    celebrate:     { left: "up",   right: "up",   bodyRotate: 0.0,  bodyY: -10, scale: 1.020, headExtra: -1.5 },
};

function gazeFor(target: GazeTarget | undefined, x: number): { x: number; y: number } | null {
    switch (target) {
        case "camera": return { x: 0, y: 0 };
        case "left": return { x: -6, y: 0 };
        case "right": return { x: 6, y: 0 };
        case "up": return { x: 0, y: -4 };
        case "down": return { x: 0, y: 4 };
        case "away": return { x: x < 700 ? -6 : 6, y: 0 };
        default: return null;
    }
}

const ArmLayer: React.FC<{
    rig: (name: string) => string;
    side: "left" | "right";
    target: ArmPose;
    progress: number;
}> = ({ rig, side, target, progress }) => {
    const upOpacity = target === "up" ? progress : 0;
    const downOpacity = target === "up" ? 1 - progress : 1;
    const lift = target === "up" ? (1 - progress) * 10 : 0;
    return (
        <>
            <Img src={rig(`arms/${side}-down.svg`)} style={{ ...layerStyle, opacity: downOpacity }} />
            <Img
                src={rig(`arms/${side}-up.svg`)}
                style={{ ...layerStyle, opacity: upOpacity, transform: `translateY(${lift}px)`, transformOrigin: "50% 50%" }}
            />
        </>
    );
};

export const Character: React.FC<CharacterProps> = ({
    characterId,
    actorId,
    x,
    y,
    scale = 1,
    emotion = "neutral",
    gesture,
    gazeTarget,
    leftArm = "down",
    rightArm = "down",
    expression,
    isSpeaking = false,
    mouthCues,
    gazeX,
    gazeY,
    animationKey,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const rig = (name: string) => staticFile(`characters/${characterId}/${name}`);

    const phaseIdentity = actorId ?? animationKey ?? `${characterId}@${Math.round(x)},${Math.round(y)}`;
    const seed = stablePhase(phaseIdentity);
    const idlePhase = seed % 257;
    const headPhase = (seed >>> 5) % 193;
    const eyePhase = (seed >>> 11) % 311;
    const speechPhase = (seed >>> 17) % 149;

    const emotionProfile = EMOTION[emotion] ?? EMOTION.neutral;
    const semanticGesture = gesture ? (GESTURE[gesture] ?? GESTURE.idle) : null;
    const targetLeft = semanticGesture?.left ?? leftArm;
    const targetRight = semanticGesture?.right ?? rightArm;

    const gestureProgress = interpolate(frame, [0, 12], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });

    const breathWave = Math.sin((frame + idlePhase) / 14);
    const bodyScaleY = 1 + breathWave * 0.0035;
    const idleHead = Math.sin((frame + headPhase) / 10.5) * 0.65;
    const listeningWave = !isSpeaking
        ? Math.sin((frame + headPhase) / 25) * emotionProfile.listenerMotion
        : 0;
    const speechNod = isSpeaking ? Math.sin((frame + speechPhase) / 3.8) * 0.55 : 0;
    const headAngle = idleHead + listeningWave + speechNod + emotionProfile.headTilt +
        (semanticGesture?.headExtra ?? 0) * gestureProgress;

    const idleLookX = Math.sin((frame + eyePhase) / 43) * 1.8;
    const idleLookY = Math.sin((frame + eyePhase * 0.7) / 57) * 0.9;
    const semanticGaze = gazeFor(gazeTarget, x);
    // gazeX/gazeY are external input; clamp() propagates rather than rejects
    // NaN, so a non-numeric value would otherwise reach translate(NaNpx, ...)
    // and silently no-op in Chromium instead of falling back to idle gaze.
    const safeGazeX = Number.isFinite(gazeX) ? gazeX : undefined;
    const safeGazeY = Number.isFinite(gazeY) ? gazeY : undefined;
    const lookX = clamp(safeGazeX ?? semanticGaze?.x ?? idleLookX, -8, 8);
    const lookY = clamp(safeGazeY ?? semanticGaze?.y ?? (idleLookY + emotionProfile.gazeY), -5, 5);

    const blinkPeriod = 94 + (seed % 53);
    const blinkOffset = (seed >>> 7) % blinkPeriod;
    const blinkCycle = (frame + blinkOffset) % blinkPeriod;
    const blinkFrames = 3 + (seed % 2);
    const blinkScale = blinkCycle < blinkFrames ? 0.06 : 1;
    const eyeScaleY = blinkScale * emotionProfile.eye;

    const mouthShape = mouthAtTime(mouthCues, frame / fps);
    const bodyRotate = emotionProfile.bodyLean + (semanticGesture?.bodyRotate ?? 0) * gestureProgress;
    const bodyY = (semanticGesture?.bodyY ?? 0) * gestureProgress;
    const gestureScale = 1 + ((semanticGesture?.scale ?? 1) - 1) * gestureProgress;
    // expression is external input (planner/manual-script supplied) interpolated
    // straight into an asset filename below - an invalid value must degrade to a
    // known-good one rather than reach <Img>, the same guarantee mouthAtTime
    // already gives mouthCues.
    const brow = expression && VALID_EXPRESSIONS.has(expression) ? expression : emotionProfile.brow;

    return (
        <div
            style={{
                position: "absolute",
                left: x,
                top: y,
                width: RIG_WIDTH,
                height: RIG_HEIGHT,
                transform: `translateY(${bodyY}px) rotate(${bodyRotate}deg) scale(${scale * gestureScale}) scaleY(${bodyScaleY})`,
                transformOrigin: "bottom center",
            }}
        >
            <Img src={rig("body.svg")} style={layerStyle} />
            <ArmLayer rig={rig} side="left" target={targetLeft} progress={gestureProgress} />
            <ArmLayer rig={rig} side="right" target={targetRight} progress={gestureProgress} />

            <div style={{ ...layerStyle, transform: `rotate(${headAngle}deg)`, transformOrigin: "50% 40%" }}>
                <Img src={rig("head.svg")} style={layerStyle} />
                <div style={{ ...layerStyle, transform: `scaleY(${eyeScaleY})`, transformOrigin: "50% 30%" }}>
                    <Img src={rig("eye-left.svg")} style={layerStyle} />
                    <Img src={rig("eye-right.svg")} style={layerStyle} />
                </div>
                <div style={{ ...layerStyle, transform: `translate(${lookX}px, ${lookY}px) scaleY(${eyeScaleY})`, transformOrigin: "50% 30%" }}>
                    <Img src={rig("pupil-left.svg")} style={layerStyle} />
                    <Img src={rig("pupil-right.svg")} style={layerStyle} />
                </div>
                <Img src={rig(`expressions/eyebrow-${brow}.svg`)} style={layerStyle} />
                <Img src={rig(`mouth/${mouthShape}.svg`)} style={layerStyle} />
            </div>
        </div>
    );
};
