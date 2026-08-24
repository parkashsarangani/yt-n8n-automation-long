import type { CSSProperties } from "react";
import { AbsoluteFill } from "remotion";
import type { BackgroundSpec } from "./Background";

interface SceneDressingProps {
  background?: BackgroundSpec;
  frame: number;
}

function norm(value?: string): string {
  return String(value ?? "").toLowerCase().trim();
}

function softShadow(opacity = 0.16): CSSProperties {
  return { boxShadow: `0 18px 48px rgba(15,23,42,${opacity})` };
}

function FramedArt({ left, top, w, h, hue = "warm" }: { left: number; top: number; w: number; h: number; hue?: "warm" | "cool" }) {
  const bg = hue === "warm"
    ? "linear-gradient(135deg,#FDE68A,#FB923C)"
    : "linear-gradient(135deg,#BFDBFE,#67E8F9)";
  return <div style={{ position: "absolute", left, top, width: w, height: h, borderRadius: 18, background: bg, border: "8px solid rgba(255,255,255,0.72)", ...softShadow(0.10) }} />;
}

function Shelf({ left, top, w }: { left: number; top: number; w: number }) {
  return (
    <div style={{ position: "absolute", left, top, width: w, height: 86 }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 6, height: 12, borderRadius: 12, background: "rgba(71,85,105,0.55)" }} />
      {[0, 1, 2, 3].map((i) => <div key={i} style={{ position: "absolute", left: 24 + i * 42, bottom: 18, width: 24, height: 42 + (i % 2) * 16, borderRadius: 6, background: i % 2 ? "#38BDF8" : "#F97316", opacity: 0.78 }} />)}
      <div style={{ position: "absolute", right: 28, bottom: 18, width: 58, height: 36, borderRadius: "18px 18px 8px 8px", background: "#A7F3D0", opacity: 0.88 }} />
    </div>
  );
}

function Rug({ x = 430, y = 635, w = 470, h = 82 }: { x?: number; y?: number; w?: number; h?: number }) {
  return <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: "50%", background: "radial-gradient(ellipse at center, rgba(251,191,36,0.28), rgba(249,115,22,0.10) 58%, transparent 70%)" }} />;
}

function PracticalLight({ frame, left = 850, top = 96 }: { frame: number; left?: number; top?: number }) {
  const glow = 0.5 + Math.sin(frame / 46) * 0.5;
  return (
    <>
      <div style={{ position: "absolute", left, top, width: 80, height: 80, borderRadius: 80, background: "rgba(253,224,71,0.60)", filter: "blur(18px)", opacity: 0.30 + glow * 0.20 }} />
      <div style={{ position: "absolute", left: left + 28, top: top + 16, width: 24, height: 120, borderRadius: 20, background: "rgba(100,116,139,0.38)" }} />
    </>
  );
}

function TableDepth({ y = 574 }: { y?: number }) {
  return <div style={{ position: "absolute", left: 246, right: 226, top: y, height: 72, borderRadius: "44px 44px 14px 14px", background: "linear-gradient(180deg, rgba(120,53,15,0.72), rgba(69,26,3,0.52))", borderTop: "8px solid rgba(255,255,255,0.18)", ...softShadow(0.18) }} />;
}

function KitchenDressing({ frame }: { frame: number }) {
  const steam = Math.sin(frame / 21) * 4;
  return (
    <>
      <div style={{ position: "absolute", left: 70, top: 82, width: 360, height: 132, borderRadius: 26, background: "rgba(255,247,237,0.48)", border: "8px solid rgba(148,163,184,0.22)" }} />
      <div style={{ position: "absolute", left: 88, top: 108, width: 70, height: 54, borderRadius: 16, background: "#F8FAFC", opacity: 0.88 }} />
      <div style={{ position: "absolute", left: 178, top: 108, width: 70, height: 54, borderRadius: 16, background: "#F8FAFC", opacity: 0.88 }} />
      <div style={{ position: "absolute", right: 96, bottom: 108, width: 270, height: 88, borderRadius: 32, background: "linear-gradient(180deg,#FDE68A,#FDBA74)", border: "8px solid rgba(120,53,15,0.26)", ...softShadow(0.14) }} />
      <div style={{ position: "absolute", right: 178, bottom: 206 + steam, width: 14, height: 58, borderRadius: 16, background: "rgba(255,255,255,0.42)", filter: "blur(4px)" }} />
      <TableDepth y={594} />
    </>
  );
}

function LivingRoomDressing({ frame }: { frame: number }) {
  return (
    <>
      <Rug />
      <FramedArt left={92} top={84} w={210} h={138} hue="warm" />
      <Shelf left={786} top={114} w={290} />
      <PracticalLight frame={frame} left={1030} top={120} />
      <div style={{ position: "absolute", left: 90, bottom: 106, width: 320, height: 110, borderRadius: "44px 44px 24px 24px", background: "linear-gradient(180deg,#FCA5A5,#FB7185)", border: "8px solid rgba(127,29,29,0.16)", ...softShadow(0.12) }} />
    </>
  );
}

function OfficeDressing({ frame }: { frame: number }) {
  const monitorGlow = 0.45 + Math.sin(frame / 33) * 0.18;
  return (
    <>
      <FramedArt left={82} top={82} w={230} h={128} hue="cool" />
      <Shelf left={860} top={92} w={300} />
      <div style={{ position: "absolute", left: 380, bottom: 126, width: 438, height: 106, borderRadius: 28, background: "linear-gradient(180deg,#CBD5E1,#94A3B8)", border: "8px solid rgba(30,41,59,0.24)", ...softShadow(0.16) }} />
      <div style={{ position: "absolute", left: 512, bottom: 244, width: 170, height: 96, borderRadius: 20, background: `rgba(56,189,248,${monitorGlow})`, border: "8px solid rgba(15,23,42,0.42)", boxShadow: "0 0 38px rgba(56,189,248,0.26)" }} />
    </>
  );
}

function HallwayDressing({ frame }: { frame: number }) {
  const streak = 0.5 + Math.sin(frame / 30) * 0.5;
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, background: "linear-gradient(90deg, rgba(15,23,42,0.10), transparent 22%, transparent 72%, rgba(15,23,42,0.12))" }} />
      <div style={{ position: "absolute", left: 160, top: 90, width: 170, height: 450, borderRadius: 22, background: "rgba(255,255,255,0.18)", border: "8px solid rgba(255,255,255,0.18)" }} />
      <div style={{ position: "absolute", right: 170, top: 92, width: 170, height: 450, borderRadius: 22, background: "rgba(255,255,255,0.14)", border: "8px solid rgba(255,255,255,0.16)" }} />
      <div style={{ position: "absolute", left: 340, right: 340, bottom: 90, height: 260, background: "linear-gradient(180deg, rgba(255,255,255,0.00), rgba(255,255,255,0.22))", opacity: 0.35 + streak * 0.14, clipPath: "polygon(30% 0, 70% 0, 100% 100%, 0 100%)" }} />
    </>
  );
}

function StreetDressing({ frame }: { frame: number }) {
  const car = (frame % 180) / 180;
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 146, background: "linear-gradient(180deg,#475569,#1E293B)" }} />
      {[0, 1, 2, 3].map((i) => <div key={i} style={{ position: "absolute", left: 120 + i * 270, top: 86 + (i % 2) * 18, width: 82, height: 260, borderRadius: "18px 18px 0 0", background: i % 2 ? "rgba(148,163,184,0.34)" : "rgba(100,116,139,0.28)" }} />)}
      <div style={{ position: "absolute", left: -180 + car * 1500, bottom: 100, width: 180, height: 62, borderRadius: "28px 28px 14px 14px", background: "#38BDF8", opacity: 0.70 }} />
    </>
  );
}

function GenericDressing({ frame }: { frame: number }) {
  return (
    <>
      <Rug x={440} y={642} w={420} h={70} />
      <FramedArt left={94} top={92} w={190} h={126} hue="cool" />
      <PracticalLight frame={frame} left={1010} top={110} />
    </>
  );
}

export function SceneDressing({ background, frame }: SceneDressingProps) {
  const location = norm(background?.location);
  return (
    <AbsoluteFill pointerEvents="none" data-art-direction="scene-dressing" style={{ zIndex: 2 }}>
      {location === "kitchen" && <KitchenDressing frame={frame} />}
      {location === "living-room" && <LivingRoomDressing frame={frame} />}
      {location === "office" && <OfficeDressing frame={frame} />}
      {(location === "hallway" || location === "school-hallway") && <HallwayDressing frame={frame} />}
      {(location === "street" || location === "park") && <StreetDressing frame={frame} />}
      {!location || !["kitchen", "living-room", "office", "hallway", "school-hallway", "street", "park"].includes(location) ? <GenericDressing frame={frame} /> : null}
    </AbsoluteFill>
  );
}
