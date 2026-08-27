import { Composition } from "remotion";
import { ExplanationScene } from "./compositions/ExplanationScene";
import { MotionPrimitiveMatrix, SubjectPrimitiveMatrix } from "./compositions/MotionPrimitiveMatrix";

const defaults = {
  role: "character-hook" as const, visualOperation: "group" as const,
  visualPrimitive: "facets-around-center" as const, visualState: "hypothesis" as const,
  numericValue: null, compositionMode: "bookend" as const,
  title: "Can one source have many forms?", keyText: "One reality, several viewpoints",
  elements: ["shared source", "form", "viewpoint"], before: "one", after: "many",
  characterCutIn: "both" as const,
  characters: [
    { characterId: "pilot", x: 0, y: 0, scale: 1, isSpeaking: false },
    { characterId: "pilot-2", x: 0, y: 0, scale: 1, isSpeaking: true },
  ],
};

export const TestRoot: React.FC = () => <>
  <Composition id="MotionPrimitiveMatrix" component={MotionPrimitiveMatrix} durationInFrames={120} fps={30} width={1920} height={1080} />
  <Composition id="SubjectPrimitiveMatrix" component={SubjectPrimitiveMatrix} durationInFrames={120} fps={30} width={1920} height={1080} />
  <Composition id="ExplanationBookendRegression" component={ExplanationScene as unknown as React.ComponentType<Record<string, unknown>>}
    durationInFrames={120} fps={30} width={1920} height={1080} defaultProps={defaults} />
</>;
