import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export type RelationshipPrimitive =
  | "network" | "hierarchy" | "one-to-many" | "many-to-one" | "facets-around-center"
  | "overlapping-sets" | "nested-context" | "cycle" | "cause-chain" | "before-after"
  | "map" | "timeline" | "quantity" | "spectrum" | "physical-transformation";

export type VisualState = "hypothesis" | "contradiction" | "mechanism" | "qualification" | "payoff";
export type CompositionMode = "bookend" | "full-model" | "reaction";

const PAPER = "#F7F4EA";
const ACCENT = "#FFD166";
const BLUE = "#65C7F7";
const GREEN = "#7DE2A8";
const RED = "#FF7D7D";
const BG = "#08101E";
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

const palette: Record<VisualState, { line: string; fill: string; muted: string }> = {
  hypothesis: { line: "#E8B96A", fill: "#3B2E22", muted: "#A78966" },
  contradiction: { line: RED, fill: "#3B2029", muted: "#9B6070" },
  mechanism: { line: BLUE, fill: "#16324A", muted: "#517C9B" },
  qualification: { line: "#B794F4", fill: "#2D2546", muted: "#75669B" },
  payoff: { line: GREEN, fill: "#183B32", muted: "#5A9A84" },
};

function useProgress() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const setup = interpolate(frame, [0, Math.max(1, durationInFrames * 0.18)], [0, 1], clamp);
  const transform = interpolate(frame, [durationInFrames * 0.16, durationInFrames * 0.78], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const consequence = interpolate(frame, [durationInFrames * 0.72, durationInFrames * 0.9], [0, 1], clamp);
  const hold = interpolate(frame, [durationInFrames * 0.9, durationInFrames], [0, 1], clamp);
  const pop = (delay = 0) => spring({ frame: frame - delay * fps, fps, config: { damping: 16, stiffness: 92 } });
  return { frame, fps, setup, transform, consequence, hold, pop };
}

function Label({ text, x, y, active = false, state }: { text?: string; x: number; y: number; active?: boolean; state: VisualState }) {
  if (!text) return null;
  const colors = palette[state];
  return <g transform={`translate(${x} ${y})`}>
    <rect x="-132" y="-34" width="264" height="68" rx="21" fill={active ? colors.fill : "#0B1424"} stroke={active ? colors.line : colors.muted} strokeWidth={active ? 4 : 2} />
    <text textAnchor="middle" dominantBaseline="middle" fill={PAPER} fontSize="31" fontWeight="820">{text.slice(0, 22)}</text>
  </g>;
}

function Edge({ x1, y1, x2, y2, progress, state, dashed = false }: { x1: number; y1: number; x2: number; y2: number; progress: number; state: VisualState; dashed?: boolean }) {
  const colors = palette[state];
  const length = Math.hypot(x2 - x1, y2 - y1);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors.line} strokeWidth="5" strokeLinecap="round"
    strokeDasharray={dashed || state === "hypothesis" ? `14 12` : `${length}`}
    strokeDashoffset={dashed || state === "hypothesis" ? 0 : length * (1 - progress)}
    opacity={0.25 + progress * 0.75} />;
}

function Center({ x = 540, y = 245, state, progress = 1 }: { x?: number; y?: number; state: VisualState; progress?: number }) {
  const colors = palette[state];
  return <g transform={`translate(${x} ${y}) scale(${0.72 + progress * 0.28})`}>
    <circle r="66" fill={colors.fill} stroke={colors.line} strokeWidth="7" />
    <circle r={22 + progress * 14} fill={colors.line} opacity="0.85" />
  </g>;
}

export function MotionDesignSystem({ primitive, state = "mechanism", elements = [], before = "", after = "", keyText = "" }: {
  primitive: RelationshipPrimitive; state?: VisualState; elements?: string[]; before?: string; after?: string; keyText?: string;
}) {
  const { setup, transform, consequence, hold, pop } = useProgress();
  const labels = [...elements, before, after].filter(Boolean).slice(0, 4);
  const colors = palette[state];
  const wrong = state === "hypothesis" || state === "contradiction";
  const base = <rect x="12" y="12" width="1056" height="486" rx="34" fill={BG} stroke={colors.muted} strokeWidth="2" opacity="0.96" />;
  let body: React.ReactNode;

  if (primitive === "network") {
    const nodes = [[190,130],[430,95],[700,120],[880,250],[660,390],[350,385],[165,285]];
    body = <>{nodes.map((n,i) => <React.Fragment key={i}><Edge x1={540} y1={245} x2={n[0]} y2={n[1]} progress={Math.max(0, transform-i*0.06)} state={state} dashed={wrong}/><circle cx={n[0]} cy={n[1]} r={18+pop(i*.06)*10} fill={i%2?BLUE:ACCENT}/></React.Fragment>)}<Center state={state} progress={setup}/><Label text={labels[0]} x={540} y={455} active state={state}/></>;
  } else if (primitive === "hierarchy") {
    const rows=[[[540,78]],[[315,220],[765,220]],[[190,385],[420,385],[660,385],[890,385]]];
    body=<>{rows.flat().map((n,i)=><circle key={i} cx={n[0]} cy={n[1]} r={24+pop(i*.06)*10} fill={i===0?colors.line:i<3?BLUE:PAPER}/>)}
      {rows[1].map((n,i)=><Edge key={"a"+i} x1={540} y1={104} x2={n[0]} y2={194} progress={transform} state={state}/>)}
      {rows[2].map((n,i)=><Edge key={"b"+i} x1={i<2?315:765} y1={246} x2={n[0]} y2={359} progress={Math.max(0,transform-.15)} state={state}/>)}
      <Label text={labels[0]} x={540} y={145} active state={state}/></>;
  } else if (primitive === "one-to-many" || primitive === "many-to-one" || primitive === "facets-around-center") {
    const targets=[[180,120],[180,370],[900,110],[900,375],[540,440]];
    const reverse=primitive==="many-to-one";
    body=<><Center state={state} progress={setup}/>{targets.map((n,i)=><React.Fragment key={i}>
      <Edge x1={reverse?n[0]:540} y1={reverse?n[1]:245} x2={reverse?540:n[0]} y2={reverse?245:n[1]} progress={Math.max(0,transform-i*.05)} state={state} dashed={wrong}/>
      <circle cx={n[0]} cy={n[1]} r={18+pop(i*.07)*9} fill={i%2?ACCENT:BLUE}/></React.Fragment>)}
      <Label text={labels[0]} x={540} y={245} active state={state}/></>;
  } else if (primitive === "overlapping-sets") {
    const spread=90*(1-transform);
    body=<><circle cx={430-spread} cy="245" r="185" fill="#65C7F733" stroke={BLUE} strokeWidth="7"/><circle cx={650+spread} cy="245" r="185" fill="#FFD16633" stroke={ACCENT} strokeWidth="7"/>
      <Label text={labels[0]} x={330-spread} y={245} state={state}/><Label text={labels[1]} x={750+spread} y={245} state={state}/><Label text={labels[2]||keyText} x={540} y={245} active state={state}/></>;
  } else if (primitive === "nested-context") {
    body=<>{[0,1,2,3].map(i=><circle key={i} cx="540" cy="245" r={70+i*58*transform} fill="none" stroke={i===3?colors.line:colors.muted} strokeWidth={i===3?9:4} opacity={setup*(.35+i*.15)}/>)}
      <Center state={state} progress={setup}/><Label text={labels[0]} x={540} y={455} active state={state}/></>;
  } else if (primitive === "cycle") {
    const pts=[[540,70],[850,245],[540,420],[230,245]];
    body=<>{pts.map((n,i)=>{const next=pts[(i+1)%pts.length];return <React.Fragment key={i}><Edge x1={n[0]} y1={n[1]} x2={next[0]} y2={next[1]} progress={Math.max(0,transform-i*.12)} state={state}/><circle cx={n[0]} cy={n[1]} r="31" fill={i%2?BLUE:ACCENT}/></React.Fragment>})}<Label text={keyText||labels[0]} x={540} y={245} active state={state}/></>;
  } else if (primitive === "cause-chain" || primitive === "timeline") {
    const xs=[120,380,650,930];
    body=<>{xs.map((x,i)=><React.Fragment key={i}>{i<3&&<Edge x1={x+42} y1={245} x2={xs[i+1]-42} y2={245} progress={Math.max(0,transform-i*.16)} state={state}/>}<circle cx={x} cy="245" r={30+pop(i*.13)*12} fill={i===3?GREEN:i%2?BLUE:ACCENT}/><Label text={labels[i]} x={x} y={350} active={i===Math.min(3,Math.floor(transform*4))} state={state}/></React.Fragment>)}</>;
  } else if (primitive === "before-after" || primitive === "physical-transformation") {
    const leftX=270+transform*80, rightX=810-transform*80;
    body=<><g opacity={1-transform*.55} transform={`translate(${leftX} 245) scale(${1-transform*.18})`}><rect x="-145" y="-105" width="290" height="210" rx={wrong?12:40} fill={wrong?"#35252A":colors.fill} stroke={wrong?RED:colors.line} strokeWidth="7" strokeDasharray={wrong?"14 10":undefined}/></g>
      <Edge x1={430} y1={245} x2={650} y2={245} progress={transform} state={state}/>
      <g opacity={.35+transform*.65} transform={`translate(${rightX} 245) scale(${.72+transform*.28})`}><circle r="118" fill={colors.fill} stroke={colors.line} strokeWidth="9"/></g>
      <Label text={before||labels[0]} x={270} y={410} state={state}/><Label text={after||labels[1]} x={810} y={410} active state={state}/></>;
  } else if (primitive === "map") {
    const points=[[170,320],[315,160],[520,295],[725,125],[900,330]];
    body=<><path d="M90 380 C220 80 360 420 500 180 S790 100 990 345" fill="none" stroke={colors.muted} strokeWidth="26" opacity=".28"/>
      {points.map((n,i)=><React.Fragment key={i}>{i<points.length-1&&<Edge x1={n[0]} y1={n[1]} x2={points[i+1][0]} y2={points[i+1][1]} progress={Math.max(0,transform-i*.12)} state={state}/>}<circle cx={n[0]} cy={n[1]} r={16+pop(i*.1)*9} fill={i===points.length-1?GREEN:ACCENT}/></React.Fragment>)}<Label text={keyText||labels[0]} x={540} y={450} active state={state}/></>;
  } else if (primitive === "quantity") {
    body=<>{Array.from({length:40},(_,i)=>{const active=i/40<transform;return <circle key={i} cx={120+(i%10)*92} cy={100+Math.floor(i/10)*96} r={active?24:13} fill={active?colors.line:colors.muted} opacity={active?1:.25}/>})}
      <text x="540" y="275" textAnchor="middle" fill={PAPER} fontSize="130" fontWeight="900" opacity={consequence}>{Math.round(transform*40)}</text></>;
  } else if (primitive === "spectrum") {
    body=<><defs><linearGradient id="spectrum"><stop stopColor="#7447FF"/><stop offset=".35" stopColor="#3C8DFF"/><stop offset=".65" stopColor="#E9E45D"/><stop offset="1" stopColor="#E84E4E"/></linearGradient></defs>
      <rect x="90" y="185" width="900" height="100" rx="50" fill="url(#spectrum)" opacity=".9"/><line x1={90+transform*900} y1="145" x2={90+transform*900} y2="335" stroke={PAPER} strokeWidth="9"/>
      <Label text={before||labels[0]} x={210} y={390} state={state}/><Label text={after||labels[1]} x={870} y={390} active state={state}/></>;
  } else {
    body=null;
  }

  return <div style={{ position:"relative", width:"100%", height:510, borderRadius:36, overflow:"hidden", boxShadow:"0 24px 70px #0008" }}>
    <svg viewBox="0 0 1080 510" style={{ width:"100%", height:"100%", display:"block" }}>{base}{body}
      {wrong&&<g opacity={consequence}><line x1="160" y1="80" x2="920" y2="430" stroke={RED} strokeWidth="15" strokeLinecap="round"/><line x1="920" y1="80" x2="160" y2="430" stroke={RED} strokeWidth="15" strokeLinecap="round"/></g>}
    </svg>
    {state!=="payoff"&&consequence>0&&keyText&&<div style={{position:"absolute",left:90,right:90,bottom:22,textAlign:"center",fontSize:38,fontWeight:900,color:state==="payoff"?GREEN:ACCENT,opacity:Math.min(1,consequence+hold*.2),textShadow:"0 5px 20px #000"}}>{keyText}</div>}
  </div>;
}

export const RELATIONSHIP_PRIMITIVES: RelationshipPrimitive[] = [
  "network","hierarchy","one-to-many","many-to-one","facets-around-center",
  "overlapping-sets","nested-context","cycle","cause-chain","before-after",
  "map","timeline","quantity","spectrum","physical-transformation",
];
