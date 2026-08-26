import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Character, type CharacterProps } from "../components/Character";

export type ExplanationRole =
  | "character-hook"
  | "diagram-build"
  | "process-flow"
  | "object-state-change"
  | "comparison"
  | "kinetic-emphasis"
  | "character-reaction"
  | "recap";

export interface ExplanationSceneProps {
  role?: ExplanationRole;
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

function CharacterRail({ characters = [], mode = "none" }: Pick<ExplanationSceneProps, "characters"> & { mode?: string }) {
  if (mode === "none") return null;
  const selected = characters.filter((character) => {
    if (mode === "both") return true;
    if (mode === "speaker") return character.isSpeaking;
    if (mode === "listener") return !character.isSpeaking;
    return false;
  }).slice(0, mode === "both" ? 2 : 1);

  return (
    <div style={{ position: "absolute", right: 42, bottom: 24, width: mode === "both" ? 570 : 310, height: 420, overflow: "hidden", zIndex: 8 }}>
      {selected.map((character, index) => (
        <Character
          key={character.characterId || index}
          {...character}
          x={index * 245}
          y={8}
          scale={0.58}
        />
      ))}
    </div>
  );
}

function Title({ children }: { children?: string }) {
  if (!children) return null;
  return <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: -1.2, color: PAPER, marginBottom: 34, maxWidth: 1320 }}>{children}</div>;
}

function Diagram({ role, elements, before, after }: Required<Pick<ExplanationSceneProps, "role">> & Pick<ExplanationSceneProps, "elements" | "before" | "after">) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const values = (elements || []).filter(Boolean).slice(0, 5);

  if (role === "comparison" || role === "object-state-change") {
    const change = spring({ frame: frame - fps * 0.35, fps, config: { damping: 16, stiffness: 110 } });
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 1fr", alignItems: "center", gap: 22, width: 1370 }}>
        {[before || values[0] || "Before", after || values[1] || "After"].map((value, index) => (
          <div key={index} style={{
            minHeight: 330, borderRadius: 30, padding: 44, display: "grid", placeItems: "center",
            color: INK, background: index ? GREEN : "#D9E2F2", fontSize: 54, fontWeight: 850,
            transform: index ? `scale(${0.86 + change * 0.14})` : "none",
            opacity: index ? 0.25 + change * 0.75 : 1,
          }}>{value}</div>
        ))}
        <div style={{ gridColumn: 2, gridRow: 1, color: ACCENT, fontSize: 76, fontWeight: 900, textAlign: "center" }}>→</div>
      </div>
    );
  }

  const nodes = values.length ? values : ["Question", "Mechanism", "Result"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, width: 1450 }}>
      {nodes.map((value, index) => {
        const enter = spring({ frame: frame - index * fps * 0.18, fps, config: { damping: 18, stiffness: 105 } });
        return (
          <div key={index} style={{ display: "contents" }}>
            <div style={{
              flex: 1, minHeight: role === "diagram-build" ? 245 : 190, borderRadius: 28,
              display: "grid", placeItems: "center", padding: 30, textAlign: "center",
              background: index === nodes.length - 1 ? GREEN : PAPER, color: INK,
              fontSize: 38, lineHeight: 1.08, fontWeight: 800,
              transform: `translateY(${(1 - enter) * 34}px) scale(${0.9 + enter * 0.1})`,
              opacity: enter,
            }}>{value}</div>
            {index < nodes.length - 1 && <div style={{ color: BLUE, fontSize: 58, fontWeight: 900, opacity: enter }}>→</div>}
          </div>
        );
      })}
    </div>
  );
}

export const ExplanationScene: React.FC<ExplanationSceneProps> = ({
  role = "diagram-build",
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
  const progress = interpolate(frame, [0, fps * 0.28], [0, 1], clamp);
  const emphasis = spring({ frame: frame - fps * 0.08, fps, config: { damping: 15, stiffness: 120 } });
  const characterDominant = role === "character-hook" || role === "character-reaction";
  const safeCharacters = useMemo(() => characters.map((character) => ({ ...character, x: 0, y: 0 })), [characters]);

  return (
    <AbsoluteFill style={{
      background: `radial-gradient(circle at 18% 18%, #17294C 0, ${BG} 48%, #070A12 100%)`,
      fontFamily: "Inter, Arial, sans-serif", overflow: "hidden",
    }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.16, backgroundImage: "linear-gradient(#65C7F722 1px, transparent 1px), linear-gradient(90deg, #65C7F722 1px, transparent 1px)", backgroundSize: "64px 64px" }} />
      <div style={{ position: "absolute", left: 92, top: 74, right: 92, bottom: 90, display: "flex", flexDirection: "column", justifyContent: "center", opacity: progress }}>
        <Title>{title}</Title>
        {characterDominant ? (
          <div style={{ width: 1200, borderLeft: `12px solid ${ACCENT}`, padding: "28px 40px", color: PAPER, fontSize: 70, lineHeight: 1.04, fontWeight: 880, letterSpacing: -2.2, transform: `translateX(${(1-emphasis)*-38}px)` }}>
            {keyText || elements[0] || "Look at what changes."}
          </div>
        ) : role === "kinetic-emphasis" || role === "recap" ? (
          <div style={{ color: PAPER, fontSize: role === "kinetic-emphasis" ? 92 : 68, maxWidth: 1350, lineHeight: 1.02, fontWeight: 900, letterSpacing: -2.8, transform: `scale(${0.91 + emphasis * 0.09})`, transformOrigin: "left center" }}>
            <span style={{ color: ACCENT }}>{keyText || elements.join(" · ")}</span>
          </div>
        ) : (
          <Diagram role={role} elements={elements} before={before} after={after} />
        )}
      </div>
      <CharacterRail characters={safeCharacters} mode={characterCutIn} />
      <div style={{ position: "absolute", left: 92, bottom: 42, color: BLUE, fontSize: 20, fontWeight: 800, letterSpacing: 3, textTransform: "uppercase" }}>
        {role.replaceAll("-", " ")}
      </div>
    </AbsoluteFill>
  );
};
