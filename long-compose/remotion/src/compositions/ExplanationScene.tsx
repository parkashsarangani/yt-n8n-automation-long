import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, type CharacterProps } from "../components/Character";

export type ExplanationRole =
  | "character-hook" | "diagram-build" | "process-flow" | "object-state-change"
  | "comparison" | "kinetic-emphasis" | "character-reaction" | "recap";

export type VisualPrimitive =
  | "particles" | "rays" | "wave" | "horizon"
  | "spectrum" | "path" | "shells" | "objects";

export type VisualOperation =
  | "stack" | "timeline" | "counter" | "compress"
  | "group" | "sort" | "scale-compare" | "payoff";

export interface ExplanationSceneProps {
  role?: ExplanationRole;
  visualOperation?: VisualOperation;
  visualPrimitive?: VisualPrimitive;
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
          x={mode === "both" ? -145 + index * 330 : -105}
          y={6}
          scale={1.12}
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

function SemanticLabels({ values }: { values: string[] }) {
  return <div style={{ position: "absolute", left: 40, right: 40, bottom: 18, display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
    {values.slice(0, 3).map((value, index) => <div key={index} style={{ color: PAPER, background: "#0B1020CC", border: "2px solid #65C7F766", borderRadius: 999, padding: "10px 18px", fontSize: 23, fontWeight: 760 }}>{value}</div>)}
  </div>;
}

function SemanticCanvas({ primitive, operation, elements, before, after, keyText }: {
  primitive: VisualPrimitive; operation: VisualOperation; elements?: string[]; before?: string; after?: string; keyText?: string;
}) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], clamp);
  const values = (elements || []).filter(Boolean);
  const pulse = 0.92 + Math.sin(frame / fps * Math.PI * 2) * 0.08;

  if (primitive === "particles") {
    const count = 52;
    return <div style={{ position: "relative", width: "100%", height: 510, borderRadius: 38, overflow: "hidden", background: "radial-gradient(circle at 50% 48%, #172D55, #060A14 72%)", boxShadow: "inset 0 0 90px #000A" }}>
      {Array.from({ length: count }, (_, index) => {
        const rawX = 4 + ((index * 37) % 92);
        const rawY = 5 + ((index * 61) % 84);
        const delay = index / count * 0.72;
        const visible = interpolate(p, [delay, Math.min(1, delay + 0.2)], [0.12, 1], clamp);
        const baseSize = 3 + (index * 7) % 9;
        let targetX = rawX;
        let targetY = rawY;
        if (operation === "compress") {
          targetX = 50 + ((index % 9) - 4) * 2.1;
          targetY = 49 + (Math.floor(index / 9) - 2) * 4.2;
        } else if (operation === "group") {
          const centers = [[24, 30], [73, 32], [49, 70]];
          const center = centers[index % centers.length];
          targetX = center[0] + ((index * 5) % 17) - 8;
          targetY = center[1] + ((index * 7) % 15) - 7;
        } else if (operation === "sort") {
          targetX = 10 + (index % 10) * 8.5;
          targetY = 10 + Math.floor(index / 10) * 14;
        } else if (operation === "stack") {
          targetX = 34 + (index % 10) * 3.7;
          targetY = 86 - Math.floor(index / 10) * 14;
        }
        const x = interpolate(p, [0.12, 0.92], [rawX, targetX], { ...clamp, easing: Easing.inOut(Easing.cubic) });
        const y = interpolate(p, [0.12, 0.92], [rawY, targetY], { ...clamp, easing: Easing.inOut(Easing.cubic) });
        const size = operation === "scale-compare"
          ? baseSize * (index % 2 ? 0.65 + p * 0.35 : 1.15 - p * 0.35)
          : baseSize;
        const gap = x > 43 && x < 58 && y > 32 && y < 66;
        const filtered = gap && p < 0.72 && !["compress", "group", "sort", "stack"].includes(operation);
        return <div key={index} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: size, height: size, borderRadius: "50%", background: index % 5 ? PAPER : BLUE, opacity: filtered ? 0.04 : visible, transform: `scale(${pulse})`, boxShadow: `0 0 ${size * 2}px ${index % 5 ? "#F7F4EA" : BLUE}` }} />;
      })}
      <div style={{ position: "absolute", left: "47%", top: "48%", width: 18, height: 18, borderRadius: "50%", background: ACCENT, boxShadow: "0 0 28px #FFD166" }} />
      <SemanticLabels values={values} />
    </div>;
  }

  if (primitive === "rays") {
    return <div style={{ position: "relative", width: "100%", height: 510, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: "48%", top: "43%", width: 74, height: 74, borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #8DE5FF, #2879B8)", boxShadow: "0 0 36px #65C7F788", zIndex: 3 }} />
      {Array.from({ length: 16 }, (_, index) => {
        const angle = index * 22.5;
        const length = interpolate(p, [index / 32, Math.min(1, index / 32 + 0.65)], [0, 520], clamp);
        return <div key={index} style={{ position: "absolute", left: "51%", top: "49%", width: length, height: 3, transformOrigin: "0 50%", transform: `rotate(${angle}deg)`, background: `linear-gradient(90deg, ${BLUE}, ${ACCENT})`, opacity: 0.35 + p * 0.55 }}><div style={{ position: "absolute", right: -7, top: -6, width: 14, height: 14, borderRadius: "50%", background: PAPER, boxShadow: "0 0 18px white" }} /></div>;
      })}
      <SemanticLabels values={values} />
    </div>;
  }

  if (primitive === "spectrum" || primitive === "wave") {
    const wavelength = interpolate(p, [0, 1], [34, 92], clamp);
    const points = Array.from({ length: 90 }, (_, i) => {
      const x = i * 12;
      const y = 235 + Math.sin((i * 12 + frame * 3) / wavelength * Math.PI * 2) * 92;
      return `${x},${y}`;
    }).join(" ");
    return <div style={{ position: "relative", width: "100%", height: 510, borderRadius: 36, overflow: "hidden", background: "#080C18" }}>
      <div style={{ position: "absolute", left: 55, right: 55, top: 72, height: 48, borderRadius: 30, background: "linear-gradient(90deg,#7447FF,#3C8DFF,#45D2C2,#E9E45D,#FF9D45,#E84E4E)", opacity: primitive === "spectrum" ? 0.8 : 0.2 }} />
      <svg viewBox="0 0 1080 470" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <polyline points={points} fill="none" stroke={primitive === "spectrum" ? "#FF765F" : BLUE} strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 12px currentColor)" }} />
        {primitive === "spectrum" && <rect x={55 + p * 760} y="52" width="8" height="320" rx="4" fill={ACCENT} />}
      </svg>
      <SemanticLabels values={values.length ? values : [before || "visible", after || "shifted"]} />
    </div>;
  }

  if (primitive === "horizon" || primitive === "shells") {
    const rings = primitive === "shells" ? 5 : 3;
    return <div style={{ position: "relative", width: "100%", height: 510, display: "grid", placeItems: "center", overflow: "hidden" }}>
      {Array.from({ length: rings }, (_, index) => {
        const size = 120 + index * 112;
        const grow = spring({ frame: frame - index * fps * 0.16, fps, config: { damping: 18, stiffness: 75 } });
        return <div key={index} style={{ position: "absolute", width: size, height: size, borderRadius: "50%", border: `${index === rings - 1 ? 10 : 4}px solid ${index === rings - 1 ? ACCENT : BLUE}`, opacity: 0.25 + grow * 0.65, transform: `scale(${0.72 + grow * 0.28})`, boxShadow: index === rings - 1 ? "0 0 36px #FFD16655" : "none" }} />;
      })}
      <div style={{ width: 28, height: 28, borderRadius: "50%", background: GREEN, boxShadow: "0 0 28px #7DE2A8" }} />
      <div style={{ position: "absolute", left: "50%", top: "50%", width: p * 390, height: 5, background: BLUE, transformOrigin: "left center", transform: `rotate(${-28 + p * 18}deg)` }} />
      <SemanticLabels values={values} />
    </div>;
  }

  if (primitive === "path") {
    const x = 70 + p * 900;
    return <div style={{ position: "relative", width: "100%", height: 510 }}>
      <div style={{ position: "absolute", left: 70, right: 70, top: 245, height: 12, borderRadius: 12, background: "#65C7F744" }} />
      <div style={{ position: "absolute", left: 70, top: 245, width: p * 900, height: 12, borderRadius: 12, background: `linear-gradient(90deg,${BLUE},${ACCENT})` }} />
      <div style={{ position: "absolute", left: x - 22, top: 222, width: 56, height: 56, borderRadius: "50%", background: PAPER, boxShadow: "0 0 42px 16px #65C7F777", transform: `scale(${pulse})` }} />
      <div style={{ position: "absolute", left: 52, top: 175, color: PAPER, fontSize: 28, fontWeight: 800 }}>{before || values[0]}</div>
      <div style={{ position: "absolute", right: 45, top: 175, color: GREEN, fontSize: 28, fontWeight: 800 }}>{after || values[values.length - 1]}</div>
      <SemanticLabels values={values.slice(1, -1)} />
    </div>;
  }

  return null;
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
  visualPrimitive = "objects",
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
        <div style={{ position: "relative", width: "100%" }}>
          {visualPrimitive === "objects"
            ? <OperationCanvas operation={visualOperation} elements={elements} before={before} after={after} keyText={keyText} />
            : <SemanticCanvas primitive={visualPrimitive} operation={visualOperation} elements={elements} before={before} after={after} keyText={keyText} />}
          {visualOperation === "payoff" ? <PayoffResolution before={before} after={after} keyText={keyText} /> : null}
        </div>
      </div>
      <BustReactionPanel characters={safeCharacters} mode={characterCutIn} />
    </AbsoluteFill>
  );
};
