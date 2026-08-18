import { Composition } from "remotion";

// Original compositions — mood-themed, hand-tuned, and correctly wired end to end.
import { StatReveal } from "./compositions/StatReveal";
import { Comparison } from "./compositions/Comparison";
import { KineticText } from "./compositions/KineticText";
import { CaptionOverlay } from "./compositions/CaptionOverlay";
import { SceneTransition } from "./compositions/SceneTransition";

// Structured-data templates — the four scene types that actually need a real
// chart/list/timeline shape rather than mood-themed single-value emphasis.
import { DataTimeline } from "./scenes/DataAnimations/DataTimeline";
import { DataRanking } from "./scenes/DataAnimations/DataRanking";
import { DataBarChart } from "./scenes/DataAnimations/DataBarChart";
import { ListNumberedVertical } from "./scenes/ListAnimations/ListNumberedVertical";

const FPS = 30;
const W = 1920;
const H = 1080;
const D = 120; // default frames

export const RemotionRoot: React.FC = () => (
    <>
        <Composition id="StatReveal" component={StatReveal} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ statValue: "3.5x", label: "MORE VIEWS", icon: "activity", mood: "upbeat" as const }} />
        <Composition id="Comparison" component={Comparison} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ leftLabel: "BEFORE", leftValue: "$100", rightLabel: "AFTER", rightValue: "$10,000", mood: "upbeat" as const }} />
        <Composition id="KineticText" component={KineticText} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ line: "This changes everything", mood: "serious" as const }} />
        <Composition id="CaptionOverlay" component={CaptionOverlay} durationInFrames={900} fps={FPS} width={W} height={H}
            defaultProps={{ words: [] as Array<{ text: string; start: number; end: number }>, commentHook: "", totalDuration: 30 }} />
        <Composition id="SceneTransition" component={SceneTransition} durationInFrames={12} fps={FPS} width={W} height={H}
            defaultProps={{ type: "crossfade" as const }} />

        <Composition id="DataTimeline" component={DataTimeline} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ events: [{ year: "1947", title: "Independence" }], title: "Timeline" }} />
        <Composition id="DataRanking" component={DataRanking} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ items: [{ rank: 1, name: "China", value: "1.4B" }], title: "Ranking" }} />
        <Composition id="DataBarChart" component={DataBarChart} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ items: [{ label: "A", value: 80 }], title: "Chart" }} />
        <Composition id="ListNumberedVertical" component={ListNumberedVertical} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ items: [{ text: "Key fact" }], title: "Key Facts" }} />
    </>
);
