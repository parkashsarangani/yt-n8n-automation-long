import { Composition } from "remotion";
import { StatReveal } from "./compositions/StatReveal";
import { Comparison } from "./compositions/Comparison";
import { KineticText } from "./compositions/KineticText";
import { CaptionOverlay } from "./compositions/CaptionOverlay";
import { SceneTransition } from "./compositions/SceneTransition";

export const RemotionRoot: React.FC = () => {
    return (
        <>
            <Composition
                id="StatReveal"
                component={StatReveal}
                durationInFrames={120}
                fps={30}
                width={1080}
                height={1920}
                defaultProps={{
                    statValue: "3.5x",
                    label: "MORE VIEWS",
                    icon: "activity",
                    mood: "upbeat" as const,
                }}
            />
            <Composition
                id="Comparison"
                component={Comparison}
                durationInFrames={120}
                fps={30}
                width={1080}
                height={1920}
                defaultProps={{
                    leftLabel: "BEFORE",
                    leftValue: "$100",
                    rightLabel: "AFTER",
                    rightValue: "$10,000",
                    mood: "upbeat" as const,
                }}
            />
            <Composition
                id="KineticText"
                component={KineticText}
                durationInFrames={120}
                fps={30}
                width={1080}
                height={1920}
                defaultProps={{
                    line: "This changes everything",
                    mood: "serious" as const,
                }}
            />
            <Composition
                id="CaptionOverlay"
                component={CaptionOverlay}
                durationInFrames={900}
                fps={30}
                width={1080}
                height={1920}
                defaultProps={{
                    words: [] as Array<{ text: string; start: number; end: number }>,
                    commentHook: "",
                    totalDuration: 30,
                }}
            />
            <Composition
                id="SceneTransition"
                component={SceneTransition}
                durationInFrames={12}
                fps={30}
                width={1080}
                height={1920}
                defaultProps={{
                    type: "crossfade" as const,
                }}
            />
        </>
    );
};
