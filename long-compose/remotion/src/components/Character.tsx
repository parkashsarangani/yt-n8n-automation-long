import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { mouthAtTime, MouthCue } from "../animation/lipsync";

// Every rig asset shares this viewBox (see public/characters/*/manifest.json),
// so layers stack with no per-file offset.
const RIG_WIDTH = 500;
const RIG_HEIGHT = 700;

export type ArmPose = "up" | "down";
export type Expression = "normal" | "angry" | "surprised";

export interface CharacterProps {
    /** Folder name under public/characters/ - e.g. "pilot" or "pilot-2". */
    characterId: string;
    x: number;
    y: number;
    scale?: number;
    leftArm?: ArmPose;
    rightArm?: ArmPose;
    expression?: Expression;
    isSpeaking?: boolean;
    mouthCues?: MouthCue[];
    /** Optional deliberate pupil offset in rig-space pixels. Lets the director make characters look at each other/props. */
    gazeX?: number;
    gazeY?: number;
}

const layerStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: RIG_WIDTH,
    height: RIG_HEIGHT,
};

/** Stable, deterministic phase seed so repeated renders are reproducible. */
function stablePhase(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export const Character: React.FC<CharacterProps> = ({
    characterId,
    x,
    y,
    scale = 1,
    leftArm = "down",
    rightArm = "down",
    expression = "normal",
    isSpeaking = false,
    mouthCues,
    gazeX,
    gazeY,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const rig = (name: string) => staticFile(`characters/${characterId}/${name}`);

    // The old implementation evaluated identical sin(frame / n) functions for
    // every character. Different frequencies do not prevent lockstep when both
    // puppets share the same frame; they still blink, breathe and look around
    // together. Derive stable per-character offsets instead. This stays fully
    // deterministic, which is important for reproducible renders/tests.
    const seed = stablePhase(characterId);
    const idlePhase = seed % 257;
    const headPhase = (seed >>> 5) % 193;
    const eyePhase = (seed >>> 11) % 311;
    const speechPhase = (seed >>> 17) % 149;

    // Keep the feet planted. Previously breathing translated the entire puppet
    // up/down, making shoes visibly float against the floor. A tiny scaleY from
    // the bottom anchor gives the torso/head a breathing read while the contact
    // point at the feet stays fixed.
    const breathWave = Math.sin((frame + idlePhase) / 14);
    const bodyScaleY = 1 + breathWave * 0.0035;

    const idleHead = Math.sin((frame + headPhase) / 10.5) * 0.8;
    const listeningTilt = !isSpeaking ? Math.sin((frame + headPhase) / 31) * 0.45 : 0;
    const speechNod = isSpeaking ? Math.sin((frame + speechPhase) / 3.4) * 0.7 : 0;
    const headAngle = idleHead + listeningTilt + speechNod;

    // Default gaze is deliberately very small. Explicit gaze values override
    // it and are clamped so pupils cannot leave the whites of the current rig.
    const idleLookX = Math.sin((frame + eyePhase) / 43) * 2.2;
    const idleLookY = Math.sin((frame + eyePhase * 0.7) / 57) * 1.2;
    const lookX = clamp(gazeX ?? idleLookX, -8, 8);
    const lookY = clamp(gazeY ?? idleLookY, -5, 5);

    // Independent deterministic blink cadence per character. The previous
    // frame % 110 rule made every on-screen character blink on exactly the same
    // frames, one of the strongest "robot puppet" tells in a two-shot.
    const blinkPeriod = 94 + (seed % 53); // 3.1-4.9s at 30fps
    const blinkOffset = (seed >>> 7) % blinkPeriod;
    const blinkCycle = (frame + blinkOffset) % blinkPeriod;
    const blinkFrames = 3 + (seed % 2);
    const eyeScaleY = blinkCycle < blinkFrames ? 0.06 : 1;

    const mouthShape = mouthAtTime(mouthCues, frame / fps);

    return (
        <div
            style={{
                position: "absolute",
                left: x,
                top: y,
                width: RIG_WIDTH,
                height: RIG_HEIGHT,
                transform: `scale(${scale}) scaleY(${bodyScaleY})`,
                transformOrigin: "bottom center",
            }}
        >
            <Img src={rig("body.svg")} style={layerStyle} />
            <Img src={rig(`arms/left-${leftArm}.svg`)} style={layerStyle} />
            <Img src={rig(`arms/right-${rightArm}.svg`)} style={layerStyle} />

            <div
                style={{
                    ...layerStyle,
                    transform: `rotate(${headAngle}deg)`,
                    transformOrigin: "50% 40%",
                }}
            >
                <Img src={rig("head.svg")} style={layerStyle} />
                <div style={{ ...layerStyle, transform: `scaleY(${eyeScaleY})`, transformOrigin: "50% 30%" }}>
                    <Img src={rig("eye-left.svg")} style={layerStyle} />
                    <Img src={rig("eye-right.svg")} style={layerStyle} />
                </div>
                <div
                    style={{
                        ...layerStyle,
                        transform: `translate(${lookX}px, ${lookY}px) scaleY(${eyeScaleY})`,
                        transformOrigin: "50% 30%",
                    }}
                >
                    <Img src={rig("pupil-left.svg")} style={layerStyle} />
                    <Img src={rig("pupil-right.svg")} style={layerStyle} />
                </div>
                <Img src={rig(`expressions/eyebrow-${expression}.svg`)} style={layerStyle} />
                <Img src={rig(`mouth/${mouthShape}.svg`)} style={layerStyle} />
            </div>
        </div>
    );
};
