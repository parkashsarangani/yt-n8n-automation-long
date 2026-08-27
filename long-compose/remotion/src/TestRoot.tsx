import { Composition } from "remotion";
import { ExplanationScene } from "./compositions/ExplanationScene";
import { MotionCompatibilityMatrix, PrimitiveStateMatrix } from "./compositions/MotionPrimitiveMatrix";

const characters = [
  { characterId: "pilot", x: 0, y: 0, scale: 1, isSpeaking: false },
  { characterId: "pilot-2", x: 0, y: 0, scale: 1, isSpeaking: true },
];
const bookend = {
  role: "character-hook" as const, visualOperation: "group" as const,
  visualPrimitive: "facets-around-center" as const, visualState: "hypothesis" as const,
  numericValue: null, compositionMode: "bookend" as const,
  title: "Can one source have many forms?", keyText: "One reality, several viewpoints",
  elements: ["shared source", "form", "viewpoint"], before: "one", after: "many",
  characterCutIn: "both" as const, characters,
};
const payoff = {
  ...bookend, role: "recap" as const, visualOperation: "payoff" as const,
  visualPrimitive: "particles" as const, visualState: "payoff" as const,
  title: "This title must not duplicate", keyText: "The darkness is evidence",
  before: "The old assumption", after: "The darkness is evidence",
};

export const TestRoot: React.FC = () => <>
  <Composition id="MotionCompatibilityMatrix" component={MotionCompatibilityMatrix} durationInFrames={120} fps={30} width={1920} height={1080} defaultProps={{ page: 0 }} />
  <Composition id="PrimitiveStateMatrix" component={PrimitiveStateMatrix} durationInFrames={120} fps={30} width={1920} height={1080} defaultProps={{ page: 0, state: "hypothesis" as const }} />
  <Composition id="ExplanationBookendRegression" component={ExplanationScene as unknown as React.ComponentType<Record<string, unknown>>}
    durationInFrames={120} fps={30} width={1920} height={1080} defaultProps={bookend} />
  <Composition id="ExplanationEmptyBookendReference" component={ExplanationScene as unknown as React.ComponentType<Record<string, unknown>>}
    durationInFrames={120} fps={30} width={1920} height={1080} defaultProps={{ ...bookend, characters: [] }} />
  <Composition id="ExplanationPayoffRegression" component={ExplanationScene as unknown as React.ComponentType<Record<string, unknown>>}
    durationInFrames={120} fps={30} width={1920} height={1080} defaultProps={payoff} />
</>;
