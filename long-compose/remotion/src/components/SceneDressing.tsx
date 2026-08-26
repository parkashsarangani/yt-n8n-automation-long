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


function ExtendedLocationDressing({ location, frame }: { location: string; frame: number }) {
  const pulse = 0.5 + Math.sin(frame / 42) * 0.5;
  if (location === "bedroom") return <><div style={{ position:"absolute", right:100, bottom:88, width:430, height:150, borderRadius:"38px 38px 20px 20px", background:"linear-gradient(180deg,#BFDBFE,#93C5FD)", boxShadow:"0 22px 50px rgba(15,23,42,.16)" }} /><div style={{ position:"absolute", right:390, bottom:215, width:115, height:60, borderRadius:24, background:"rgba(255,255,255,.9)" }} /><PracticalLight frame={frame} left={120} top={110}/></>;
  if (location === "cafe") return <><TableDepth y={590}/><div style={{position:"absolute",left:110,top:70,width:190,height:120,borderRadius:20,background:"#422006",border:"8px solid rgba(255,255,255,.45)"}}/><div style={{position:"absolute",right:120,top:40,width:34,height:160,background:"rgba(71,85,105,.28)"}}/><div style={{position:"absolute",right:93,top:180,width:88,height:50,borderRadius:"50%",background:`rgba(253,224,71,${.45+pulse*.2})`,filter:"blur(5px)"}}/></>;
  if (location === "classroom") return <><div style={{position:"absolute",left:115,top:70,width:560,height:260,borderRadius:18,background:"#14532D",border:"12px solid #78350F",boxShadow:"0 18px 42px rgba(15,23,42,.16)"}}/><div style={{position:"absolute",left:190,right:170,bottom:80,height:95,borderRadius:"28px 28px 10px 10px",background:"linear-gradient(180deg,#D6D3D1,#A8A29E)"}}/></>;
  if (location === "library") return <><Shelf left={70} top={72} w={350}/><Shelf left={820} top={92} w={350}/><TableDepth y={585}/><div style={{position:"absolute",left:30,right:30,top:220,height:9,background:"rgba(120,53,15,.26)"}}/></>;
  if (location === "airport") return <><div style={{position:"absolute",left:70,right:70,top:60,height:320,borderRadius:30,background:"linear-gradient(180deg,rgba(186,230,253,.58),rgba(224,242,254,.22))",border:"10px solid rgba(255,255,255,.52)"}}/><div style={{position:"absolute",left:630,top:85,width:300,height:82,borderRadius:16,background:"#1E3A8A",color:"white",fontSize:30,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",letterSpacing:2}}>GATES  A · B</div><div style={{position:"absolute",right:180,bottom:105,width:100,height:72,borderRadius:18,background:"#F97316",boxShadow:"0 18px 28px rgba(15,23,42,.16)"}}/></>;
  if (location === "shop") return <><Shelf left={70} top={90} w={390}/><Shelf left={760} top={90} w={390}/><div style={{position:"absolute",left:0,right:0,bottom:50,height:110,background:"linear-gradient(180deg,#FDE68A,#F59E0B)",borderTop:"8px solid rgba(15,23,42,.16)"}}/></>;
  if (location === "bathroom") return <><div style={{position:"absolute",left:100,top:72,width:320,height:260,borderRadius:30,background:"linear-gradient(135deg,#DBEAFE,#F8FAFC)",border:"12px solid rgba(148,163,184,.45)",boxShadow:`0 0 ${18+pulse*16}px rgba(186,230,253,.35)`}}/><div style={{position:"absolute",left:150,bottom:135,width:300,height:76,borderRadius:"50% 50% 24px 24px",background:"#F8FAFC",border:"8px solid rgba(100,116,139,.24)"}}/></>;
  if (location === "hospital-room") return <><div style={{position:"absolute",right:110,bottom:105,width:470,height:120,borderRadius:"34px 34px 18px 18px",background:"linear-gradient(180deg,#DBEAFE,#BFDBFE)",border:"8px solid rgba(30,64,175,.22)"}}/><div style={{position:"absolute",right:165,top:90,width:160,height:110,borderRadius:20,background:"#F8FAFC",border:"7px solid rgba(100,116,139,.28)"}}/><div style={{position:"absolute",right:185,top:135,width:120,height:6,background:"#22C55E",boxShadow:`0 0 ${8+pulse*8}px rgba(34,197,94,.45)`}}/></>;
  if (location === "studio") return <><div style={{position:"absolute",left:120,top:70,width:320,height:190,borderRadius:24,background:"linear-gradient(135deg,#1E293B,#334155)",border:"9px solid #64748B",boxShadow:"0 0 55px rgba(56,189,248,.2)"}}/><div style={{position:"absolute",right:120,top:80,width:90,height:260,transform:"rotate(18deg)",background:"linear-gradient(180deg,rgba(253,224,71,.32),transparent)",clipPath:"polygon(35% 0,65% 0,100% 100%,0 100%)"}}/><TableDepth y={610}/></>;
  if (location === "car-interior") return <><div style={{position:"absolute",left:80,right:80,top:60,height:360,borderRadius:"48% 48% 20% 20%",background:"linear-gradient(180deg,rgba(186,230,253,.68),rgba(148,163,184,.24))",border:"12px solid rgba(30,41,59,.5)"}}/><div style={{position:"absolute",left:0,right:0,bottom:0,height:185,borderRadius:"50% 50% 0 0",background:"linear-gradient(180deg,#334155,#0F172A)"}}/></>;
  if (location === "park") return <><div style={{position:"absolute",left:85,bottom:100,width:380,height:96,borderRadius:"18px 18px 10px 10px",background:"#92400E",boxShadow:"0 18px 32px rgba(15,23,42,.14)"}}/><div style={{position:"absolute",right:100,top:65,width:150,height:150,borderRadius:"50%",background:"rgba(34,197,94,.38)",filter:"blur(2px)"}}/></>;
  return <GenericDressing frame={frame}/>;
}

export function SceneDressing({ background, frame }: SceneDressingProps) {
  const location = norm(background?.location);
  return (
    <AbsoluteFill data-art-direction="scene-dressing" style={{ zIndex: 2, pointerEvents: "none" }}>
      {location === "kitchen" && <KitchenDressing frame={frame} />}
      {location === "living-room" && <LivingRoomDressing frame={frame} />}
      {location === "office" && <OfficeDressing frame={frame} />}
      {(location === "hallway" || location === "school-hallway") && <HallwayDressing frame={frame} />}
      {location === "street" && <StreetDressing frame={frame} />}
      {location && !["kitchen", "living-room", "office", "hallway", "school-hallway", "street"].includes(location) ? <ExtendedLocationDressing location={location} frame={frame} /> : null}
      {!location ? <GenericDressing frame={frame} /> : null}
    </AbsoluteFill>
  );
}
