import { useMemo, type ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, type CharacterProps } from "../components/Character";
import { MotionDesignSystem, type VisualPrimitive, type VisualOperation, type VisualState, type CompositionMode } from "./MotionDesignSystem";

export type ExplanationRole =
  | "character-hook" | "diagram-build" | "process-flow" | "object-state-change"
  | "comparison" | "kinetic-emphasis" | "character-reaction" | "recap";


export interface ExplanationSceneProps {
  role?: ExplanationRole;
  visualOperation?: VisualOperation;
  visualPrimitive?: VisualPrimitive;
  visualState?: VisualState;
  numericValue?: number | null;
  compositionMode?: CompositionMode;
  title?: string;
  keyText?: string;
  elements?: string[];
  before?: string;
  after?: string;
  characterCutIn?: "none" | "speaker" | "listener" | "both";
  soundCue?: string;
  characters?: CharacterProps[];
}

const BG = "#0B1020";
const PAPER = "#F7F4EA";
const ACCENT = "#FFD166";
const GREEN = "#7DE2A8";
const PRIMITIVE_GLOW: Partial<Record<VisualPrimitive, string>> = {
  particles: "#4169A8",
  rays: "#2D8FB8",
  wave: "#4E63C8",
  horizon: "#3D8B72",
  spectrum: "#9158A8",
  path: "#2C7A9C",
  shells: "#5A739E",
  objects: "#354D78",
  network: "#275E78", hierarchy: "#594B8A", "one-to-many": "#386F92", "many-to-one": "#386F92",
  "facets-around-center": "#77518E", "overlapping-sets": "#665099", "nested-context": "#4A628F",
  cycle: "#2C7781", "cause-chain": "#356D92", "before-after": "#536B87", map: "#276F68",
  timeline: "#315F8B", quantity: "#715B36", "physical-transformation": "#5E4F89",
};

function backgroundField(primitive: VisualPrimitive, glow: string) {
  if (["map","path","timeline","cause-chain"].includes(primitive)) return {
    backgroundImage: `linear-gradient(118deg, transparent 18%, ${glow}2B 19%, transparent 21%, transparent 48%, ${glow}20 49%, transparent 51%)`,
    backgroundSize: "440px 440px",
  };
  if (["network","facets-around-center","one-to-many","many-to-one","overlapping-sets"].includes(primitive)) return {
    backgroundImage: `radial-gradient(circle, ${glow}55 1.5px, transparent 2px)`,
    backgroundSize: "46px 46px",
  };
  if (["hierarchy","nested-context","shells","objects"].includes(primitive)) return {
    backgroundImage: `linear-gradient(${glow}35 1px, transparent 1px), linear-gradient(90deg, ${glow}35 1px, transparent 1px)`,
    backgroundSize: "72px 72px",
  };
  if (["quantity","before-after"].includes(primitive)) return {
    backgroundImage: `linear-gradient(90deg, ${glow}20 0 48%, transparent 48% 52%, ${glow}12 52%)`,
    backgroundSize: "100% 100%",
  };
  return {
    backgroundImage: `radial-gradient(ellipse at 30% 35%, ${glow}36, transparent 42%), radial-gradient(ellipse at 75% 62%, ${glow}20, transparent 38%)`,
    backgroundSize: "100% 100%",
  };
}
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

function BustReactionPanel({ characters = [], mode = "none" }: Pick<ExplanationSceneProps, "characters"> & { mode?: string }) {
  if (mode === "none") return null;
  const selected = characters.filter((character) => {
    if (mode === "both") return true;
    if (mode === "speaker") return character.isSpeaking;
    if (mode === "listener") return !character.isSpeaking;
    return false;
  }).slice(0, mode === "both" ? 2 : 1);
  if (!selected.length) return null;

  const width = mode === "both" ? 760 : 430;
  return (
    <div style={{
      position: "absolute", right: 48, top: 94, bottom: 168, width,
      overflow: "hidden", borderRadius: 38, zIndex: 8,
      background: "linear-gradient(180deg, #21365F 0%, #101A31 100%)",
      border: "3px solid #65C7F766", boxShadow: "0 24px 70px #0008",
    }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 35%, #65C7F722, transparent 62%)" }} />
      {selected.map((character, index) => (
        <Character
          key={character.characterId || index}
          {...character}
          x={mode === "both" ? -110 + index * 365 : -35}
          y={430}
          scale={1.45}
        />
      ))}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 74, background: "linear-gradient(transparent, #0B1020)" }} />
    </div>
  );
}

type CompositionProps = {
  children: ReactNode;
  characters: CharacterProps[];
  cutIn: "none" | "speaker" | "listener" | "both";
  opacity: number;
};

function ContentStage({ children, right, opacity }: { children: ReactNode; right: number; opacity: number }) {
  return <div style={{ position: "absolute", left: 86, top: 62, right, bottom: 176, display: "flex", flexDirection: "column", justifyContent: "center", opacity }}>{children}</div>;
}

function BookendComposition({ children, characters, opacity }: CompositionProps) {
  return <><ContentStage right={850} opacity={opacity}>{children}</ContentStage><BustReactionPanel characters={characters} mode="both" /></>;
}

function FullModelComposition({ children, opacity }: CompositionProps) {
  return <ContentStage right={86} opacity={opacity}>{children}</ContentStage>;
}

function ReactionComposition({ children, characters, cutIn, opacity }: CompositionProps) {
  const panelMode = cutIn === "none" ? "listener" : cutIn;
  return <><ContentStage right={panelMode === "both" ? 850 : 520} opacity={opacity}>{children}</ContentStage><BustReactionPanel characters={characters} mode={panelMode} /></>;
}

function CompositionFrame(props: CompositionProps & { mode: CompositionMode }) {
  if (props.mode === "bookend") return <BookendComposition {...props} />;
  if (props.mode === "reaction") return <ReactionComposition {...props} />;
  return <FullModelComposition {...props} />;
}

function Title({ children }: { children?: string }) {
  if (!children) return null;
  return <div style={{ fontSize: 56, fontWeight: 840, letterSpacing: -1.1, color: PAPER, marginBottom: 24, maxWidth: 1320 }}>{children}</div>;
}

function PayoffResolution({ before, after, keyText }: { before?: string; after?: string; keyText?: string }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const revealAt = Math.max(fps * 0.8, durationInFrames * 0.62);
  const resolve = interpolate(frame, [revealAt, Math.max(revealAt + 1, durationInFrames - 1)], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const ring = spring({ frame: frame - revealAt, fps, config: { damping: 15, stiffness: 74 } });
  if (resolve <= 0) return null;
  return <div style={{
    position: "absolute", inset: 0, zIndex: 8, display: "grid", placeItems: "center",
    background: `radial-gradient(circle at 50% 48%, rgba(9,22,40,${0.5 + resolve * 0.24}), rgba(5,8,16,${resolve * 0.9}))`,
    opacity: resolve,
  }}>
    <div style={{ position: "absolute", width: 380 + ring * 350, height: 380 + ring * 350, borderRadius: "50%", border: `12px solid ${GREEN}`, opacity: 0.18 + resolve * 0.42, boxShadow: "0 0 80px #7DE2A844" }} />
    <div style={{ textAlign: "center", maxWidth: 940, padding: "0 44px", transform: `translateY(${(1 - resolve) * 54}px) scale(${0.9 + resolve * 0.1})` }}>
      {before ? <div style={{ color: PAPER, fontSize: 34, fontWeight: 760, opacity: 0.72 * (1 - resolve), marginBottom: 18 }}>{before}</div> : null}
      <div style={{ color: ACCENT, fontSize: 74, lineHeight: 1.02, fontWeight: 930, textShadow: "0 8px 30px #000" }}>{keyText || after}</div>
      <div style={{ width: resolve * 680, height: 10, borderRadius: 8, background: GREEN, margin: "30px auto 0", boxShadow: "0 0 24px #7DE2A866" }} />
    </div>
  </div>;
}

export const ExplanationScene: React.FC<ExplanationSceneProps> = ({
  role = "diagram-build",
  visualOperation = "timeline",
  visualPrimitive = "objects",
  visualState = "mechanism",
  numericValue = null,
  compositionMode = "full-model",
  title = "",
  keyText = "",
  elements = [],
  before = "",
  after = "",
  characterCutIn = "none",
  characters = [],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = interpolate(frame, [0, fps * 0.25], [0, 1], clamp);
  const characterDominant = compositionMode === "bookend" || role === "character-hook" || role === "character-reaction";
  const safeCharacters = useMemo(() => characters.map((character) => ({ ...character, x: 0, y: 0 })), [characters]);
  const primitiveGlow = PRIMITIVE_GLOW[visualPrimitive] ?? "#365B82";
  const field = backgroundField(visualPrimitive, primitiveGlow);
  const isPayoff = visualOperation === "payoff";

  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 24% 22%, ${primitiveGlow}66 0, ${BG} 48%, #070A12 100%)`, fontFamily: "Inter, Arial, sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.18, ...field }} />
      <CompositionFrame mode={compositionMode} characters={safeCharacters} cutIn={characterCutIn} opacity={progress}>
        {!isPayoff ? <Title>{title}</Title> : null}
        {!isPayoff && characterDominant && keyText ? <div style={{ color: PAPER, fontSize: 48, lineHeight: 1.05, fontWeight: 860, borderLeft: `10px solid ${ACCENT}`, padding: "16px 28px", marginBottom: 24 }}>{keyText}</div> : null}
        <div style={{ position: "relative", width: "100%" }}>
          <div style={{ opacity: isPayoff ? 0.38 : 1 }}><MotionDesignSystem primitive={visualPrimitive} operation={visualOperation} state={visualState} numericValue={numericValue} elements={elements} before={before} after={after} keyText={keyText} /></div>
          {isPayoff ? <PayoffResolution before={before} after={after} keyText={keyText} /> : null}
        </div>
      </CompositionFrame>
    </AbsoluteFill>
  );
};
