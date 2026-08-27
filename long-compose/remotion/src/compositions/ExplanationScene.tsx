import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, type CharacterProps } from "../components/Character";

export type ExplanationRole =
  | "character-hook" | "diagram-build" | "process-flow" | "object-state-change"
  | "comparison" | "kinetic-emphasis" | "character-reaction" | "recap";

export type VisualOperation =
  | "stack" | "timeline" | "counter" | "compress"
  | "group" | "sort" | "scale-compare" | "payoff";

export interface ExplanationSceneProps {
  role?: ExplanationRole;
  visualOperation?: VisualOperation;
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
const INK = "#172033";
const ACCENT = "#FFD166";
const BLUE = "#65C7F7";
const GREEN = "#7DE2A8";
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

  const width = mode === "both" ? 690 : 390;
  return (
    <div style={{
      position: "absolute", right: 48, top: 116, bottom: 176, width,
      overflow: "hidden", borderRadius: 38, zIndex: 8,
      background: "linear-gradient(180deg, #21365F 0%, #101A31 100%)",
      border: "3px solid #65C7F755", boxShadow: "0 24px 70px #0008",
    }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 35%, #65C7F722, transparent 62%)" }} />
      {selected.map((character, index) => (
        <Character
          key={character.characterId || index}
          {...character}
          x={mode === "both" ? -25 + index * 320 : 20}
          y={86}
          scale={0.82}
        />
      ))}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 74, background: "linear-gradient(transparent, #0B1020)" }} />
    </div>
  );
}

function Title({ children }: { children?: string }) {
  if (!children) return null;
  return <div style={{ fontSize: 44, fontWeight: 820, letterSpacing: -1.1, color: PAPER, marginBottom: 24, maxWidth: 1320 }}>{children}</div>;
}

function Card({ label, accent = false, style = {} }: { label: string; accent?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{
      borderRadius: 24, padding: "24px 30px", color: INK,
      background: accent ? GREEN : PAPER, fontSize: 34, lineHeight: 1.08,
      fontWeight: 800, textAlign: "center", boxShadow: "0 14px 36px #0004", ...style,
    }}>{label}</div>
  );
}

function OperationCanvas({ operation, elements, before, after, keyText }: {
  operation: VisualOperation; elements?: string[]; before?: string; after?: string; keyText?: string;
}) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const values = (elements || []).filter(Boolean).slice(0, 5);
  const nodes = values.length ? values : ["Start", "Change", "Result"];
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], clamp);
  const breathe = 1 + Math.sin(frame / fps * Math.PI * 2) * 0.012;
  const enter = (index: number) => spring({ frame: frame - index * fps * 0.18, fps, config: { damping: 18, stiffness: 105 } });

  if (operation === "stack") {
    return <div style={{ position: "relative", width: 1040, height: 500 }}>
      {nodes.map((value, index) => {
        const e = enter(index);
        const lift = (1 - p) * (nodes.length - index) * 10;
        return <Card key={index} label={value} accent={index === nodes.length - 1} style={{
          position: "absolute", width: 610, left: 120 + index * 55,
          bottom: 38 + index * 74 + lift, opacity: e,
          transform: `translateX(${(1 - e) * -80}px) scale(${0.94 + e * 0.06})`,
          zIndex: index + 1,
        }} />;
      })}
      <div style={{ position: "absolute", right: 50, top: 105, color: ACCENT, fontSize: 72, fontWeight: 900 }}>{nodes.length}</div>
    </div>;
  }

  if (operation === "timeline") {
    const x = 65 + p * 870;
    return <div style={{ position: "relative", width: 1040, height: 430 }}>
      <div style={{ position: "absolute", left: 65, right: 65, top: 210, height: 10, borderRadius: 9, background: "#65C7F744" }} />
      <div style={{ position: "absolute", left: 65, top: 210, height: 10, width: p * 870, borderRadius: 9, background: BLUE }} />
      {nodes.map((value, index) => {
        const at = 65 + index * (870 / Math.max(1, nodes.length - 1));
        const e = enter(index);
        return <div key={index} style={{ position: "absolute", left: at - 92, top: index % 2 ? 244 : 74, width: 184, opacity: e }}>
          <div style={{ color: PAPER, fontSize: 25, fontWeight: 780, textAlign: "center" }}>{value}</div>
          <div style={{ position: "absolute", left: 82, top: index % 2 ? -46 : 108, width: 22, height: 22, borderRadius: 99, background: index === nodes.length - 1 ? GREEN : BLUE, boxShadow: "0 0 0 8px #65C7F722" }} />
        </div>;
      })}
      <div style={{ position: "absolute", left: x - 3, top: 165, width: 6, height: 100, background: ACCENT, boxShadow: "0 0 20px #FFD166" }} />
    </div>;
  }

  if (operation === "counter") {
    const count = Math.max(1, Math.round(p * nodes.length));
    return <div style={{ width: 1040, height: 450, display: "grid", gridTemplateColumns: "360px 1fr", gap: 54, alignItems: "center" }}>
      <div style={{ color: ACCENT, fontSize: 172, lineHeight: 0.8, fontWeight: 920, fontVariantNumeric: "tabular-nums", transform: `scale(${breathe})` }}>{count}</div>
      <div style={{ display: "grid", gap: 16 }}>
        {nodes.map((value, index) => <Card key={index} label={value} accent={index < count} style={{ opacity: index < count ? 1 : 0.24, transform: `translateX(${index < count ? 0 : 34}px)`, transition: "none" }} />)}
      </div>
    </div>;
  }

  if (operation === "compress") {
    return <div style={{ position: "relative", width: 1080, height: 460 }}>
      {nodes.map((value, index) => {
        const startX = index * (900 / Math.max(1, nodes.length - 1));
        const endX = 380 + index * 18;
        const x = interpolate(p, [0, 0.82], [startX, endX], { ...clamp, easing: Easing.inOut(Easing.cubic) });
        return <Card key={index} label={value} accent={p > 0.82} style={{ position: "absolute", left: x, top: 150 + Math.sin(index * 2.1) * 65 * (1 - p), width: 190, opacity: 0.75 + p * 0.25, transform: `scale(${1 - p * 0.16})` }} />;
      })}
      <div style={{ position: "absolute", left: 330, right: 310, bottom: 24, color: ACCENT, fontSize: 32, textAlign: "center", opacity: interpolate(p, [0.68, 1], [0, 1], clamp), fontWeight: 850 }}>{after || keyText || "One compact group"}</div>
    </div>;
  }

  if (operation === "group") {
    const centers = [[230, 150], [700, 150], [470, 340]];
    return <div style={{ position: "relative", width: 1050, height: 480 }}>
      {nodes.map((value, index) => {
        const startX = 70 + index * 205;
        const startY = 80 + (index % 2) * 260;
        const center = centers[index % centers.length];
        return <Card key={index} label={value} accent={index % 3 === 2} style={{
          position: "absolute", width: 210,
          left: interpolate(p, [0, 0.88], [startX, center[0]], { ...clamp, easing: Easing.inOut(Easing.cubic) }),
          top: interpolate(p, [0, 0.88], [startY, center[1]], { ...clamp, easing: Easing.inOut(Easing.cubic) }),
          transform: `scale(${0.9 + p * 0.08})`,
        }} />;
      })}
      {centers.map((center, i) => <div key={i} style={{ position: "absolute", left: center[0] - 35, top: center[1] - 35, width: 280, height: 145, borderRadius: 80, border: "3px dashed #65C7F766", opacity: interpolate(p, [0.45, 0.8], [0, 1], clamp) }} />)}
    </div>;
  }

  if (operation === "sort") {
    const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].localeCompare(nodes[b]));
    return <div style={{ position: "relative", width: 1080, height: 470 }}>
      {nodes.map((value, index) => {
        const target = order.indexOf(index);
        const startY = 30 + index * 82;
        const endY = 30 + target * 82;
        const y = interpolate(p, [0.15, 0.86], [startY, endY], { ...clamp, easing: Easing.inOut(Easing.cubic) });
        return <Card key={index} label={value} accent={target === 0} style={{ position: "absolute", left: 210 + target * p * 22, top: y, width: 610, transform: `scale(${breathe})` }} />;
      })}
    </div>;
  }

  if (operation === "scale-compare") {
    const leftScale = interpolate(p, [0, 1], [1, 0.72], clamp);
    const rightScale = interpolate(p, [0, 1], [0.72, 1.12], clamp);
    return <div style={{ width: 1080, height: 470, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 70, alignItems: "center" }}>
      <Card label={before || nodes[0] || "Before"} style={{ minHeight: 260, display: "grid", placeItems: "center", fontSize: 48, transform: `scale(${leftScale})` }} />
      <Card label={after || nodes[1] || "After"} accent style={{ minHeight: 260, display: "grid", placeItems: "center", fontSize: 48, transform: `scale(${rightScale})` }} />
    </div>;
  }

  const resolve = spring({ frame: frame - fps * 0.25, fps, config: { damping: 13, stiffness: 82 } });
  return <div style={{ width: 1120, height: 500, display: "grid", placeItems: "center", position: "relative" }}>
    <div style={{ position: "absolute", width: 420 + p * 340, height: 420 + p * 340, borderRadius: "50%", border: `18px solid ${GREEN}`, opacity: 0.18 + p * 0.42, transform: `scale(${resolve})` }} />
    <div style={{ textAlign: "center", zIndex: 2 }}>
      <div style={{ color: PAPER, fontSize: 44, fontWeight: 760, opacity: 1 - p * 0.72, transform: `translateY(${-p * 44}px)` }}>{before || nodes[0]}</div>
      <div style={{ color: ACCENT, fontSize: 82, lineHeight: 1.02, fontWeight: 920, marginTop: 26, transform: `scale(${0.86 + resolve * 0.14})` }}>{keyText || after || nodes[nodes.length - 1]}</div>
      <div style={{ width: p * 720, maxWidth: 720, height: 10, borderRadius: 8, background: GREEN, margin: "32px auto 0" }} />
    </div>
  </div>;
}

export const ExplanationScene: React.FC<ExplanationSceneProps> = ({
  role = "diagram-build",
  visualOperation = "timeline",
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
  const characterDominant = role === "character-hook" || role === "character-reaction";
  const hasPanel = characterCutIn !== "none";
  const safeCharacters = useMemo(() => characters.map((character) => ({ ...character, x: 0, y: 0 })), [characters]);

  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 18% 18%, #17294C 0, ${BG} 48%, #070A12 100%)`, fontFamily: "Inter, Arial, sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.14, backgroundImage: "linear-gradient(#65C7F722 1px, transparent 1px), linear-gradient(90deg, #65C7F722 1px, transparent 1px)", backgroundSize: "64px 64px" }} />
      <div style={{ position: "absolute", left: 86, top: 62, right: hasPanel ? (characterCutIn === "both" ? 780 : 480) : 86, bottom: 176, display: "flex", flexDirection: "column", justifyContent: "center", opacity: progress }}>
        <Title>{title}</Title>
        {characterDominant && keyText ? <div style={{ color: PAPER, fontSize: 48, lineHeight: 1.05, fontWeight: 860, borderLeft: `10px solid ${ACCENT}`, padding: "16px 28px", marginBottom: 24 }}>{keyText}</div> : null}
        <OperationCanvas operation={visualOperation} elements={elements} before={before} after={after} keyText={keyText} />
      </div>
      <BustReactionPanel characters={safeCharacters} mode={characterCutIn} />
    </AbsoluteFill>
  );
};
