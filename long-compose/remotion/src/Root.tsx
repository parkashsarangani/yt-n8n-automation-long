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

// Cartoon puppet scene - layered SVG characters, lip-synced via Rhubarb.
import { CartoonScene } from "./compositions/CartoonScene";
import { ExplanationScene } from "./compositions/ExplanationScene";

const FPS = 30;
const W = 1920;
const H = 1080;
const D = 120; // default frames

export const RemotionRoot: React.FC = () => (
    <>
        <Composition id="StatReveal" component={StatReveal as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ statValue: "3.5x", label: "MORE VIEWS", icon: "activity", mood: "upbeat" as const }} />
        <Composition id="Comparison" component={Comparison as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ leftLabel: "BEFORE", leftValue: "$100", rightLabel: "AFTER", rightValue: "$10,000", mood: "upbeat" as const }} />
        <Composition id="KineticText" component={KineticText as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ line: "This changes everything", mood: "serious" as const }} />
        <Composition id="CaptionOverlay" component={CaptionOverlay as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={900} fps={FPS} width={W} height={H}
            defaultProps={{ words: [] as Array<{ text: string; start: number; end: number }>, commentHook: "", totalDuration: 30 }} />
        <Composition id="SceneTransition" component={SceneTransition as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={12} fps={FPS} width={W} height={H}
            defaultProps={{ type: "crossfade" as const }} />

        <Composition id="DataTimeline" component={DataTimeline as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ events: [{ year: "1947", title: "Independence" }], title: "Timeline" }} />
        <Composition id="DataRanking" component={DataRanking as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ items: [{ rank: 1, name: "China", value: "1.4B" }], title: "Ranking" }} />
        <Composition id="DataBarChart" component={DataBarChart as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ items: [{ label: "A", value: 80 }], title: "Chart" }} />
        <Composition id="ListNumberedVertical" component={ListNumberedVertical as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{ items: [{ text: "Key fact" }], title: "Key Facts" }} />

        <Composition id="ExplanationScene" component={ExplanationScene as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{
                role: "diagram-build" as const,
                visualOperation: "timeline" as const,
                title: "The mechanism",
                keyText: "",
                elements: ["Signal", "Compression", "Result"],
                before: "",
                after: "",
                characterCutIn: "none" as const,
                soundCue: "none",
                characters: [],
            }} />

        <Composition id="CartoonScene" component={CartoonScene as unknown as React.ComponentType<Record<string, unknown>>} durationInFrames={D} fps={FPS} width={W} height={H}
            defaultProps={{
                mood: "neutral" as const,
                background: {
                    location: "bedroom",
                    variant: "night",
                    tone: "scary" as const,
                    layers: { back: true, middle: true, front: true },
                },
                characters: [
                    { characterId: "pilot", x: 260, y: 380, scale: 1, isSpeaking: true },
                    { characterId: "pilot-2", x: 1100, y: 380, scale: 1, expression: "surprised" as const },
                ],
                camera: { type: "pan" as const, panFrom: 0, panTo: -80 },
            }} />
    </>
);
