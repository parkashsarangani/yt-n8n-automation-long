import { useMemo, type ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, type CharacterProps } from "../components/Character";
import { MotionDesignSystem, type VisualPrimitive, type VisualOperation, type VisualState, type CompositionMode, type EntityIconMap } from "./MotionDesignSystem";

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
  entityIdentityKeys?: string[];
  entityIcons?: EntityIconMap;
  before?: string;
  after?: string;
  characterCutIn?: "none" | "speaker" | "listener" | "both";
  soundCue?: string;
  characters?: CharacterProps[];
  rendererDiagnosticMode?: "normal" | "foreground-only" | "background-only";
}

const BG = "#08101E";
const PAPER = "#F7F4EA";
const ACCENT = "#FFD166";
const GREEN = "#7DE2A8";
const RED = "#FF7D7D";
const PRIMITIVE_GLOW: Partial<Record<VisualPrimitive, string>> = {
  particles: "#4169A8", rays: "#2D8FB8", wave: "#4E63C8", horizon: "#3D8B72", spectrum: "#9158A8", path: "#2C7A9C", shells: "#5A739E", objects: "#354D78",
  network: "#275E78", hierarchy: "#594B8A", "one-to-many": "#386F92", "many-to-one": "#386F92", "facets-around-center": "#77518E", "overlapping-sets": "#665099", "nested-context": "#4A628F",
  cycle: "#2C7781", "cause-chain": "#356D92", "before-after": "#536B87", map: "#276F68", timeline: "#315F8B", quantity: "#715B36", "physical-transformation": "#5E4F89",
};
function backgroundField(primitive: VisualPrimitive, glow: string) {
  if (["map","path","timeline","cause-chain"].includes(primitive)) return { backgroundImage: `linear-gradient(118deg, transparent 18%, ${glow}2B 19%, transparent 21%, transparent 48%, ${glow}20 49%, transparent 51%)`, backgroundSize: "440px 440px" };
  if (["network","facets-around-center","one-to-many","many-to-one","overlapping-sets"].includes(primitive)) return { backgroundImage: `radial-gradient(circle, ${glow}55 1.5px, transparent 2px)`, backgroundSize: "46px 46px" };
  if (["hierarchy","nested-context","shells","objects"].includes(primitive)) return { backgroundImage: `linear-gradient(${glow}35 1px, transparent 1px), linear-gradient(90deg, ${glow}35 1px, transparent 1px)`, backgroundSize: "72px 72px" };
  if (["quantity","before-after"].includes(primitive)) return { backgroundImage: `linear-gradient(90deg, ${glow}20 0 48%, transparent 48% 52%, ${glow}12 52%)`, backgroundSize: "100% 100%" };
  return { backgroundImage: `radial-gradient(ellipse at 30% 35%, ${glow}36, transparent 42%), radial-gradient(ellipse at 75% 62%, ${glow}20, transparent 38%)`, backgroundSize: "100% 100%" };
}
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

function BustReactionPanel({ characters = [], mode = "none" }: Pick<ExplanationSceneProps, "characters"> & { mode?: string }) {
  if (mode === "none") return null;
  const selected = characters.filter((character) => mode === "both" || (mode === "speaker" ? character.isSpeaking : mode === "listener" ? !character.isSpeaking : false)).slice(0, mode === "both" ? 2 : 1);
  // Character staging is now an overlay, not half the canvas. This preserves
  // expressive reactions while leaving enough spatial bandwidth for the model
  // to remain the dominant information-bearing visual.
  const width = mode === "both" ? 620 : 360;
  return <div style={{ position: "absolute", right: 48, top: 94, bottom: 168, width, overflow: "hidden", borderRadius: 38, zIndex: 8, background: "linear-gradient(180deg, #21365F 0%, #101A31 100%)", border: "3px solid #65C7F766", boxShadow: "0 24px 70px #0008" }}>
    <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 35%, #65C7F722, transparent 62%)" }} />
    {selected.map((character, index) => <Character key={character.characterId || index} {...character} x={mode === "both" ? -150 + index * 300 : -70} y={430} scale={1.4} />)}
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 74, background: "linear-gradient(transparent, #08101E)" }} />
  </div>;
}

function CharacterModelInteraction({ operation, state, visible }: { operation: VisualOperation; state: VisualState; visible: boolean }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  if (!visible) return null;
  const reach = interpolate(frame, [fps * .2, fps * .85], [0, 1], clamp);
  const consequence = interpolate(frame, [durationInFrames * 0.72, durationInFrames * 0.9], [0, 1], clamp);
  const y = operation === "compress" ? 410 : operation === "group" ? 330 : operation === "payoff" ? 270 : 365;
  const tentative = state === "hypothesis", breaking = state === "contradiction";
  const targetX = 1180 - reach * 250 + (breaking ? consequence * 70 : 0), targetY = y - (breaking ? consequence * 34 : 0);
  const stroke = breaking ? RED : ACCENT, dash = tentative ? "10 14" : breaking ? "22 6" : "18 16";
  return <svg data-character-model-interaction="true" viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0, zIndex: 7, pointerEvents: "none" }}>
    <path d={`M1510 520 Q${1380-reach*120} ${y-80} ${targetX} ${targetY}`} fill="none" stroke={stroke} strokeWidth={breaking ? 10 : 8} strokeLinecap="round" strokeDasharray={dash} opacity={(tentative ? .1 : .15) + reach * ((tentative ? .35 : breaking ? .75 : .55) - (tentative ? .1 : .15))}/>
    <circle cx={targetX} cy={targetY} r={(tentative ? 9 : 12) + reach*10 + (breaking ? consequence * 8 : 0)} fill={stroke} opacity={tentative ? reach * .6 : reach}/>
    {breaking && consequence > 0 && <circle cx={targetX} cy={targetY} r={18 + consequence * 46} fill="none" stroke={RED} strokeWidth={4} opacity={(1 - consequence) * .7} />}
  </svg>;
}

type CompositionProps = { children: ReactNode; characters: CharacterProps[]; cutIn: "none" | "speaker" | "listener" | "both"; opacity: number };
function ContentStage({ children, right, opacity }: { children: ReactNode; right: number; opacity: number }) {
  return <div style={{ position: "absolute", left: 56, top: 38, right, bottom: 132, display: "flex", flexDirection: "column", justifyContent: "center", opacity }}>{children}</div>;
}
// Composition mode, rather than scene position, owns spatial allocation. That
// makes an interior bookend/reaction scene benefit from the same full-frame
// watchability correction as the opening and closing scenes.
function BookendComposition({ children, characters, opacity }: CompositionProps) { return <><ContentStage right={610} opacity={opacity}>{children}</ContentStage><BustReactionPanel characters={characters} mode="both" /></>; }
function FullModelComposition({ children, opacity }: CompositionProps) { return <ContentStage right={56} opacity={opacity}>{children}</ContentStage>; }
function ReactionComposition({ children, characters, cutIn, opacity }: CompositionProps) {
  const panelMode = cutIn === "none" ? "listener" : cutIn;
  return <><ContentStage right={panelMode === "both" ? 610 : 380} opacity={opacity}>{children}</ContentStage><BustReactionPanel characters={characters} mode={panelMode} /></>;
}
function CompositionFrame(props: CompositionProps & { mode: CompositionMode }) {
  if (props.mode === "bookend") return <BookendComposition {...props} />;
  if (props.mode === "reaction") return <ReactionComposition {...props} />;
  return <FullModelComposition {...props} />;
}
function Title({ children }: { children?: string }) { return children ? <div style={{ fontSize: 60, fontWeight: 840, letterSpacing: -1.1, color: PAPER, marginBottom: 20, maxWidth: 1450 }}>{children}</div> : null; }

function PayoffResolution({ after, keyText }: { before?: string; after?: string; keyText?: string }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const revealAt = Math.max(fps * .8, durationInFrames * .62);
  const resolve = interpolate(frame, [revealAt, Math.max(revealAt + 1, durationInFrames - 1)], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const ring = spring({ frame: frame - revealAt, fps, config: { damping: 15, stiffness: 74 } });
  if (resolve <= 0) return null;
  return <div style={{ position: "absolute", inset: 0, zIndex: 8, display: "grid", placeItems: "center", background: `radial-gradient(circle at 50% 48%, rgba(9,22,40,${.5 + resolve * .24}), rgba(5,8,16,${resolve * .9}))`, opacity: resolve }}>
    <div style={{ position: "absolute", width: 420 + ring * 330, height: 420 + ring * 330, borderRadius: "50%", border: `10px solid ${GREEN}`, opacity: .16 + resolve * .38, boxShadow: "0 0 80px #7DE2A844" }} />
    <div data-payoff-copy="single" style={{ textAlign: "center", maxWidth: 1080, padding: "0 44px", transform: `translateY(${(1 - resolve) * 40}px) scale(${.92 + resolve * .08})` }}>
      <div style={{ color: ACCENT, fontSize: 72, lineHeight: 1.02, fontWeight: 930, textShadow: "0 8px 30px #000" }}>{keyText || after}</div>
      <div style={{ width: resolve * 640, height: 8, borderRadius: 8, background: GREEN, margin: "24px auto 0", boxShadow: "0 0 24px #7DE2A866" }} />
    </div>
  </div>;
}

export const ExplanationScene: React.FC<ExplanationSceneProps> = ({
  role = "diagram-build", visualOperation = "timeline", visualPrimitive = "objects", visualState = "mechanism", numericValue = null,
  compositionMode = "full-model", title = "", keyText = "", elements = [], entityIdentityKeys = [], entityIcons = {}, before = "", after = "",
  characterCutIn = "none", characters = [], rendererDiagnosticMode = "normal",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = interpolate(frame, [0, fps * .25], [0, 1], clamp);
  const characterDominant = compositionMode === "bookend" || role === "character-hook" || role === "character-reaction";
  const safeCharacters = useMemo(() => characters.map((character) => ({ ...character, x: 0, y: 0 })), [characters]);
  const primitiveGlow = PRIMITIVE_GLOW[visualPrimitive] ?? "#365B82", field = backgroundField(visualPrimitive, primitiveGlow);
  const isPayoff = visualOperation === "payoff", showTitle = compositionMode === "bookend" && !isPayoff;
  const showInteraction = compositionMode === "reaction" && characterCutIn !== "none";
  const compositionScale = compositionMode === "full-model" ? (isPayoff ? 1.18 : 1.26) : compositionMode === "reaction" ? 1.08 : 1.06;
  const scaledWidth = `${100 / compositionScale}%`, scaledHeight = Math.round(510 * compositionScale);
  // foreground-only is the production treatment for full-model scenes:
  // geometry floats on the episode field instead of being trapped inside the
  // same rounded card on every shot. Bookend/reaction scenes retain their
  // character staging but now allocate substantially more room to the model.
  const motionMode = compositionMode === "full-model" && rendererDiagnosticMode === "normal" ? "foreground-only" : rendererDiagnosticMode;

  return <AbsoluteFill style={{ background: `radial-gradient(circle at 24% 22%, ${primitiveGlow}66 0, ${BG} 48%, #070A12 100%)`, fontFamily: "Inter, Arial, sans-serif", overflow: "hidden" }}>
    <div style={{ position: "absolute", inset: 0, opacity: .24, ...field }} />
    <CharacterModelInteraction operation={visualOperation} state={visualState} visible={showInteraction} />
    <CompositionFrame mode={compositionMode} characters={safeCharacters} cutIn={characterCutIn} opacity={progress}>
      {showTitle ? <Title>{title}</Title> : null}
      {!isPayoff && characterDominant && keyText ? <div style={{ color: PAPER, fontSize: 48, lineHeight: 1.05, fontWeight: 860, borderLeft: `10px solid ${ACCENT}`, padding: "16px 28px", marginBottom: 24 }}>{keyText}</div> : null}
      <div style={{ position: "relative", width: "100%", minHeight: scaledHeight, display: "grid", placeItems: "center" }}>
        <div style={{ position: "relative", opacity: isPayoff ? .22 : 1, width: scaledWidth, transform: `scale(${compositionScale})`, transformOrigin: "center center" }}>
          <MotionDesignSystem diagnosticMode={motionMode} primitive={visualPrimitive} operation={visualOperation} state={visualState} numericValue={numericValue} elements={elements} entityIdentityKeys={entityIdentityKeys} entityIcons={entityIcons} before={before} after={after} keyText={keyText} />
        </div>
        {/* Sibling of the dimmed diagram, not a child of it: PayoffResolution
            is the closing statement the whole episode resolves to, and CSS
            opacity on an ancestor multiplies through regardless of the
            child's own opacity/zIndex. Nesting it inside the isPayoff-dimmed
            div (as an earlier version of this refactor did) rendered the
            payoff copy at 22% opacity -- readable in source, invisible on
            screen. */}
        {isPayoff ? <PayoffResolution before={before} after={after} keyText={keyText} /> : null}
      </div>
    </CompositionFrame>
  </AbsoluteFill>;
};