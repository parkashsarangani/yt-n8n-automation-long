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
}

const layerStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: RIG_WIDTH,
    height: RIG_HEIGHT,
};

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
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const rig = (name: string) => staticFile(`characters/${characterId}/${name}`);

    // Idle motion - subtle, continuous, never fully still. Frequencies are
    // deliberately not round numbers of the fps so two characters on screen
    // together don't fall into visible lockstep.
    const breathe = Math.sin(frame / 14) * 2;
    const headBob = Math.sin(frame / 9) * 1.5;
    const lookX = Math.sin(frame / 40) * 3;
    const talkBounce = isSpeaking ? Math.sin(frame * 1.8) * 3 : 0;

    // Blink: ~4 frames closed every 110 frames (roughly every 3.7s at 30fps).
    const blinkCycle = frame % 110;
    const eyeScaleY = blinkCycle <= 4 ? 0.05 : 1;

    const mouthShape = mouthAtTime(mouthCues, frame / fps);

    return (
        <div
            style={{
                position: "absolute",
                left: x,
                top: y,
                width: RIG_WIDTH,
                height: RIG_HEIGHT,
                transform: `scale(${scale}) translateY(${breathe}px)`,
                transformOrigin: "bottom center",
            }}
        >
            <Img src={rig("body.svg")} style={layerStyle} />
            <Img src={rig(`arms/left-${leftArm}.svg`)} style={layerStyle} />
            <Img src={rig(`arms/right-${rightArm}.svg`)} style={layerStyle} />

            <div
                style={{
                    ...layerStyle,
                    transform: `rotate(${headBob}deg) translateY(${talkBounce}px)`,
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
                        transform: `translateX(${lookX}px) scaleY(${eyeScaleY})`,
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
