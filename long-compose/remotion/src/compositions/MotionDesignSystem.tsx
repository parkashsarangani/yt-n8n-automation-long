import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export type SubjectPrimitive = "particles" | "rays" | "wave" | "horizon" | "spectrum" | "path" | "shells" | "objects";
export type RelationshipPrimitive =
  | "network" | "hierarchy" | "one-to-many" | "many-to-one" | "facets-around-center"
  | "overlapping-sets" | "nested-context" | "cycle" | "cause-chain" | "before-after"
  | "map" | "timeline" | "quantity" | "spectrum" | "physical-transformation";
export type VisualPrimitive = SubjectPrimitive | RelationshipPrimitive;
export type VisualOperation = "stack" | "timeline" | "counter" | "compress" | "group" | "sort" | "scale-compare" | "payoff";
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
  const setup = interpolate(frame, [0, Math.max(1, durationInFrames * 0.16)], [0, 1], clamp);
  const transform = interpolate(frame, [durationInFrames * 0.14, durationInFrames * 0.78], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const consequence = interpolate(frame, [durationInFrames * 0.72, durationInFrames * 0.9], [0, 1], clamp);
  const hold = interpolate(frame, [durationInFrames * 0.9, durationInFrames], [0, 1], clamp);
  const pop = (delay = 0) => spring({ frame: frame - delay * fps, fps, config: { damping: 16, stiffness: 92 } });
  return { setup, transform, consequence, hold, pop };
}

function Label({ text, x, y, active = false, state }: { text?: string; x: number; y: number; active?: boolean; state: VisualState }) {
  if (!text) return null;
  const colors = palette[state];
  return <g transform={`translate(${x} ${y})`}>
    <rect x="-132" y="-34" width="264" height="68" rx="21" fill={active ? colors.fill : "#0B1424"} stroke={active ? colors.line : colors.muted} strokeWidth={active ? 4 : 2} />
    <text textAnchor="middle" dominantBaseline="middle" fill={PAPER} fontSize="31" fontWeight="820">{text.slice(0, 22)}</text>
  </g>;
}

function DirectedEdge({ x1, y1, x2, y2, progress, state, curved = false }: {
  x1: number; y1: number; x2: number; y2: number; progress: number; state: VisualState; curved?: boolean;
}) {
  const colors = palette[state];
  const length = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  const dash = state === "hypothesis" ? "14 12" : `${length}`;
  const offset = state === "hypothesis" ? 0 : length * (1 - progress);
  const d = curved ? `M${x1} ${y1} Q540 ${Math.min(y1, y2) - 90} ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
  return <path d={d} fill="none" stroke={colors.line} strokeWidth="6" strokeLinecap="round"
    strokeDasharray={dash} strokeDashoffset={offset} markerEnd="url(#motion-arrow)" opacity={0.22 + progress * 0.78} />;
}

function Dot({ x, y, r = 28, fill = BLUE, opacity = 1 }: { x: number; y: number; r?: number; fill?: string; opacity?: number }) {
  return <circle cx={x} cy={y} r={r} fill={fill} opacity={opacity} />;
}

type GeometryProps = {
  primitive: VisualPrimitive;
  state: VisualState;
  labels: string[];
  before: string;
  after: string;
  keyText: string;
  numericValue: number | null;
  progress: number;
  pop: (delay?: number) => number;
};

function Geometry({ primitive, state, labels, before, after, keyText, numericValue, progress, pop }: GeometryProps) {
  const colors = palette[state];
  const commonStroke = { fill: "none", stroke: colors.line, strokeWidth: 7, strokeLinecap: "round" as const, strokeDasharray: state === "hypothesis" ? "15 12" : undefined };

  if (primitive === "particles") {
    return <>{Array.from({ length: 28 }, (_, i) => {
      const x = 105 + (i % 7) * 142;
      const y = 82 + Math.floor(i / 7) * 110;
      return <Dot key={i} x={x} y={y} r={10 + pop(i * 0.025) * 13} fill={i % 4 === 0 ? ACCENT : colors.line} opacity={0.3 + progress * 0.7} />;
    })}<Label text={labels[0] || keyText} x={540} y={455} active state={state} /></>;
  }
  if (primitive === "rays") {
    const ends: Array<[number, number]> = [[100,90],[70,245],[110,420],[970,85],[1010,245],[970,420]];
    return <><Dot x={540} y={245} r={58} fill={ACCENT}/>{ends.map(([x,y],i)=><DirectedEdge key={i} x1={540} y1={245} x2={x} y2={y} progress={Math.max(0,progress-i*.07)} state={state}/>)}</>;
  }
  if (primitive === "wave") {
    const amplitude = 35 + progress * 65;
    const points = Array.from({length:80},(_,i)=>`${70+i*12},${245+Math.sin(i*.42)*amplitude}`).join(" ");
    return <><polyline points={points} {...commonStroke}/><DirectedEdge x1={90} y1={390} x2={990} y2={390} progress={progress} state={state}/><Label text={labels[0]||keyText} x={540} y={445} active state={state}/></>;
  }
  if (primitive === "horizon") {
    return <><circle cx="540" cy="245" r={70+progress*130} {...commonStroke}/><circle cx="540" cy="245" r="30" fill={ACCENT}/><path d="M90 245 H990" {...commonStroke} opacity=".35"/><Label text={after||labels[0]} x={540} y={445} active state={state}/></>;
  }
  if (primitive === "spectrum") {
    return <><defs><linearGradient id="motion-spectrum"><stop stopColor="#7447FF"/><stop offset=".35" stopColor="#3C8DFF"/><stop offset=".65" stopColor="#E9E45D"/><stop offset="1" stopColor="#E84E4E"/></linearGradient></defs>
      <rect x="90" y="185" width="900" height="100" rx="50" fill="url(#motion-spectrum)" opacity=".9"/><line x1={90+progress*900} y1="145" x2={90+progress*900} y2="335" stroke={PAPER} strokeWidth="9"/>
      <Label text={before||labels[0]} x={210} y={390} state={state}/><Label text={after||labels[1]} x={870} y={390} active state={state}/></>;
  }
  if (primitive === "path") {
    return <><path d="M95 390 C230 80 370 420 510 190 S805 100 985 330" {...commonStroke} opacity=".28"/>
      <path d="M95 390 C230 80 370 420 510 190 S805 100 985 330" {...commonStroke} pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress}/>
      <Dot x={95+progress*890} y={390-progress*60} r={22} fill={ACCENT}/><Label text={keyText||labels[0]} x={540} y={455} active state={state}/></>;
  }
  if (primitive === "shells") {
    return <>{[0,1,2,3].map(i=><circle key={i} cx="540" cy="245" r={65+i*58*progress} {...commonStroke} opacity={.35+i*.15}/>)}
      <Dot x={540} y={245} r={32} fill={ACCENT}/><Label text={labels[0]||keyText} x={540} y={455} active state={state}/></>;
  }
  if (primitive === "objects") {
    return <>{labels.slice(0,4).map((label,i)=>{const x=190+(i%2)*700;const y=145+Math.floor(i/2)*210;return <React.Fragment key={i}><rect x={x-110} y={y-65} width="220" height="130" rx="28" fill={colors.fill} stroke={colors.line} strokeWidth="5"/><Label text={label} x={x} y={y} active={i===Math.floor(progress*4)} state={state}/></React.Fragment>})}</>;
  }
  if (primitive === "network") {
    const nodes: Array<[number,number]>=[[160,125],[390,80],[700,105],[925,210],[780,400],[470,385],[150,325]];
    const links: Array<[number,number]>=[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0],[1,5],[2,4],[0,5]];
    return <>{links.map(([a,b],i)=><DirectedEdge key={i} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} progress={Math.max(0,progress-i*.045)} state={state}/>)}
      {nodes.map(([x,y],i)=><Dot key={i} x={x} y={y} r={18+pop(i*.04)*9} fill={i%3===0?ACCENT:BLUE}/>)}</>;
  }
  if (primitive === "hierarchy") {
    const children: Array<[number,number]>=[[210,380],[430,380],[650,380],[870,380]];
    return <><Label text={labels[0]||"Root"} x={540} y={85} active state={state}/>
      <DirectedEdge x1={540} y1={120} x2={330} y2={230} progress={progress} state={state}/><DirectedEdge x1={540} y1={120} x2={750} y2={230} progress={progress} state={state}/>
      <Dot x={330} y={245} r={34} fill={BLUE}/><Dot x={750} y={245} r={34} fill={BLUE}/>
      {children.map(([x,y],i)=><React.Fragment key={i}><DirectedEdge x1={i<2?330:750} y1={270} x2={x} y2={y-25} progress={Math.max(0,progress-.18)} state={state}/><Dot x={x} y={y} r={25} fill={ACCENT}/></React.Fragment>)}</>;
  }
  if (primitive === "one-to-many") {
    const targets: Array<[number,number]>=[[850,85],[920,180],[940,300],[860,410]];
    return <><Label text={labels[0]||before} x={220} y={245} active state={state}/>{targets.map(([x,y],i)=><React.Fragment key={i}><DirectedEdge x1={352} y1={245} x2={x-30} y2={y} progress={Math.max(0,progress-i*.08)} state={state}/><Dot x={x} y={y} r={24} fill={i%2?BLUE:ACCENT}/></React.Fragment>)}</>;
  }
  if (primitive === "many-to-one") {
    const sources: Array<[number,number]>=[[150,85],[90,180],[80,300],[160,410]];
    return <>{sources.map(([x,y],i)=><React.Fragment key={i}><Dot x={x} y={y} r={24} fill={i%2?BLUE:ACCENT}/><DirectedEdge x1={x+30} y1={y} x2={720} y2={245} progress={Math.max(0,progress-i*.08)} state={state}/></React.Fragment>)}<Label text={after||labels[0]} x={850} y={245} active state={state}/></>;
  }
  if (primitive === "facets-around-center") {
    const facets: Array<[number,number]>=[[540,65],[820,150],[820,350],[540,430],[260,350],[260,150]];
    return <>{facets.map(([x,y],i)=><React.Fragment key={i}><path d={`M540 245 L${x} ${y}`} {...commonStroke} opacity={.2+progress*.65}/><polygon points={`${x},${y-30} ${x+34},${y} ${x},${y+30} ${x-34},${y}`} fill={i%2?BLUE:ACCENT} opacity={.45+progress*.55}/></React.Fragment>)}
      <circle cx="540" cy="245" r="84" fill={colors.fill} stroke={colors.line} strokeWidth="8"/><Label text={labels[0]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "overlapping-sets") {
    const spread=105*(1-progress);
    return <><circle cx={430-spread} cy="245" r="180" fill="#65C7F733" stroke={BLUE} strokeWidth="7"/><circle cx={650+spread} cy="245" r="180" fill="#FFD16633" stroke={ACCENT} strokeWidth="7"/>
      <Label text={labels[0]} x={320-spread} y={245} state={state}/><Label text={labels[1]} x={760+spread} y={245} state={state}/><Label text={labels[2]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "nested-context") {
    const sizes=[360,280,200,120];
    return <>{sizes.map((size,i)=><rect key={i} x={540-size*progress/2} y={245-size*progress/2} width={size*progress} height={size*progress} rx={30+i*5} fill={i===3?colors.fill:"none"} stroke={i===0?colors.line:colors.muted} strokeWidth={i===0?8:4}/>)}
      <Label text={labels[0]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "cycle") {
    const pts: Array<[number,number]>=[[540,70],[850,245],[540,420],[230,245]];
    return <>{pts.map(([x,y],i)=>{const next=pts[(i+1)%pts.length]!;return <React.Fragment key={i}><DirectedEdge x1={x} y1={y} x2={next[0]} y2={next[1]} progress={Math.max(0,progress-i*.12)} state={state} curved/><Dot x={x} y={y} r={31} fill={i%2?BLUE:ACCENT}/></React.Fragment>})}<Label text={keyText||labels[0]} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "cause-chain") {
    const xs=[120,385,650,920];
    return <>{xs.map((x,i)=><React.Fragment key={i}>{i<3&&<DirectedEdge x1={x+40} y1={245} x2={xs[i+1]!-40} y2={245} progress={Math.max(0,progress-i*.16)} state={state}/>}<Dot x={x} y={245} r={30+pop(i*.12)*10} fill={i===3?GREEN:i%2?BLUE:ACCENT}/><Label text={labels[i]} x={x} y={350} active={i===Math.min(3,Math.floor(progress*4))} state={state}/></React.Fragment>)}</>;
  }
  if (primitive === "before-after") {
    return <><rect x="90" y="100" width="390" height="290" rx="34" fill={colors.fill} stroke={colors.muted} strokeWidth="6"/><rect x="600" y="100" width="390" height="290" rx="34" fill={colors.fill} stroke={colors.line} strokeWidth="8" opacity={.3+progress*.7}/>
      <Label text={before||labels[0]} x={285} y={245} state={state}/><DirectedEdge x1={490} y1={245} x2={585} y2={245} progress={progress} state={state}/><Label text={after||labels[1]} x={795} y={245} active state={state}/></>;
  }
  if (primitive === "map") {
    const places: Array<[number,number]>=[[130,360],[315,135],[520,305],[735,110],[950,340]];
    return <><path d="M70 410 Q210 40 385 250 T690 210 T1010 355" fill="none" stroke={colors.muted} strokeWidth="30" opacity=".24"/>
      {places.map(([x,y],i)=><React.Fragment key={i}>{i<places.length-1&&<DirectedEdge x1={x} y1={y} x2={places[i+1]![0]} y2={places[i+1]![1]} progress={Math.max(0,progress-i*.13)} state={state}/>}<g transform={`translate(${x} ${y}) scale(.55)`}><path d="M0 0 c-20-30-45-5-45 17 0 33 45 68 45 68s45-35 45-68c0-22-25-47-45-17z" fill={i===places.length-1?GREEN:ACCENT}/></g></React.Fragment>)}</>;
  }
  if (primitive === "timeline") {
    const xs=[130,350,570,790,970];
    return <><path d="M90 245 H990" {...commonStroke} opacity=".35"/>{xs.map((x,i)=><React.Fragment key={i}><line x1={x} y1="195" x2={x} y2="295" stroke={i/4<=progress?colors.line:colors.muted} strokeWidth="8"/><circle cx={x} cy="245" r={i/4<=progress?24:12} fill={i/4<=progress?ACCENT:colors.muted}/>{i<4&&<Label text={labels[i]} x={x} y={365} active={i===Math.floor(progress*5)} state={state}/>}</React.Fragment>)}<line x1={90+progress*900} y1="155" x2={90+progress*900} y2="335" stroke={PAPER} strokeWidth="8"/></>;
  }
  if (primitive === "quantity") {
    const authored = [before, after, keyText, ...labels].join(" ").match(/\d+(?:\.\d+)?/);
    const target = typeof numericValue === "number" && Number.isFinite(numericValue) ? numericValue : authored ? Number(authored[0]) : Math.max(1, labels.length || 10);
    const dots = Math.max(5, Math.min(60, Math.round(target)));
    const active = Math.round(dots*progress);
    return <>{Array.from({length:dots},(_,i)=><Dot key={i} x={120+(i%10)*92} y={90+Math.floor(i/10)*65} r={i<active?22:11} fill={i<active?colors.line:colors.muted} opacity={i<active?1:.25}/>)}
      <text x="540" y="430" textAnchor="middle" fill={PAPER} fontSize="92" fontWeight="900">{Math.round(target*progress).toLocaleString()}</text></>;
  }
  return <><g transform={`translate(540 245) rotate(${progress*180})`}><rect x="-170" y="-100" width="340" height="200" rx={20+progress*50} fill={colors.fill} stroke={colors.line} strokeWidth="8"/><circle r={progress*90} fill={GREEN} opacity={progress*.55}/></g>
    <Label text={before||labels[0]} x={260} y={430} state={state}/><Label text={after||labels[1]||keyText} x={820} y={430} active state={state}/></>;
}

function OperationStage({ operation, progress, state, children }: { operation: VisualOperation; progress: number; state: VisualState; children: React.ReactNode }) {
  const colors = palette[state];
  const transform = operation === "compress"
    ? `translate(540 245) scale(${1-progress*.18} ${1-progress*.08}) translate(-540 -245)`
    : operation === "group"
      ? `translate(540 245) scale(${.84+progress*.16}) translate(-540 -245)`
      : operation === "sort"
        ? `translate(540 245) rotate(${(1-progress)*-4}) translate(-540 -245)`
        : operation === "scale-compare"
          ? `translate(540 245) scale(${.9+progress*.1}) translate(-540 -245)`
          : operation === "payoff"
            ? `translate(540 245) scale(${.92+progress*.08}) translate(-540 -245)`
            : `translate(0 ${operation==="stack"?(1-progress)*54:0})`;
  return <g transform={transform} opacity={.18+progress*.82}>
    {operation === "timeline" ? <g clipPath="url(#operation-reveal)">{children}</g> : children}
    {operation === "stack" && [0,1,2].map(i=><rect key={i} x={390-i*16} y={420-i*13} width={300+i*32} height="12" rx="6" fill={colors.line} opacity={.25+i*.2}/>)}
    {operation === "counter" && <text x="1000" y="92" textAnchor="end" fill={colors.line} fontSize="64" fontWeight="900">{Math.round(progress*100)}%</text>}
    {operation === "compress" && <><path d={`M${80+progress*165} 170 v150`} stroke={colors.line} strokeWidth="10"/><path d={`M${1000-progress*165} 170 v150`} stroke={colors.line} strokeWidth="10"/></>}
    {operation === "group" && <><circle cx="360" cy="245" r={60+progress*55} fill="none" stroke={colors.muted} strokeWidth="5"/><circle cx="720" cy="245" r={60+progress*55} fill="none" stroke={colors.muted} strokeWidth="5"/></>}
    {operation === "sort" && [0,1,2,3].map(i=><line key={i} x1={300+i*155} y1={450-i*15} x2={390+i*155} y2={450-i*15} stroke={colors.line} strokeWidth="9"/>)}
    {operation === "scale-compare" && <><line x1="140" y1="440" x2={140+progress*300} y2="440" stroke={ACCENT} strokeWidth="12"/><line x1="620" y1="440" x2={620+progress*380} y2="440" stroke={GREEN} strokeWidth="12"/></>}
    {operation === "payoff" && <circle cx="540" cy="245" r={170+progress*80} fill="none" stroke={GREEN} strokeWidth="8" opacity={.15+progress*.5}/>}
  </g>;
}

function StateDecorator({ state, consequence }: { state: VisualState; consequence: number }) {
  if (state === "hypothesis") return <g opacity={.25+consequence*.75}><circle cx="980" cy="80" r="34" fill="#3B2E22" stroke="#E8B96A" strokeWidth="5"/><text x="980" y="92" textAnchor="middle" fill={PAPER} fontSize="38" fontWeight="900">?</text></g>;
  if (state === "contradiction") return <g opacity={consequence}><path d="M470 170 l55 55 -40 55 70 70" fill="none" stroke={RED} strokeWidth="16" strokeLinecap="round"/><path d="M610 155 l-45 70 50 45 -55 80" fill="none" stroke={RED} strokeWidth="10" strokeLinecap="round"/></g>;
  if (state === "qualification") return <rect x="48" y="48" width="984" height="414" rx="52" fill="none" stroke="#B794F4" strokeWidth="6" strokeDasharray="18 14" opacity={.3+consequence*.65}/>;
  if (state === "payoff") return <circle cx="540" cy="245" r={190+consequence*55} fill="none" stroke={GREEN} strokeWidth="10" opacity={consequence*.55}/>;
  return null;
}

export function MotionDesignSystem({ primitive, operation = "timeline", state = "mechanism", numericValue = null, elements = [], before = "", after = "", keyText = "" }: {
  primitive: VisualPrimitive; operation?: VisualOperation; state?: VisualState; numericValue?: number | null; elements?: string[]; before?: string; after?: string; keyText?: string;
}) {
  const { setup, transform, consequence, hold, pop } = useProgress();
  const labels = [...elements, before, after].filter(Boolean).slice(0, operation === "timeline" || primitive === "cause-chain" ? 4 : 3);
  const colors = palette[state];
  return <div style={{ position:"relative", width:"100%", height:510, borderRadius:36, overflow:"hidden", boxShadow:"0 24px 70px #0008" }}>
    <svg viewBox="0 0 1080 510" style={{ width:"100%", height:"100%", display:"block" }}>
      <defs>
        <marker id="motion-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill={colors.line}/></marker>
        <clipPath id="operation-reveal"><rect x="0" y="0" width={1080*transform} height="510"/></clipPath>
      </defs>
      <rect x="12" y="12" width="1056" height="486" rx="34" fill={BG} stroke={colors.muted} strokeWidth="2" opacity="0.96" />
      <OperationStage operation={operation} progress={transform} state={state}>
        <Geometry primitive={primitive} state={state} labels={labels} before={before} after={after} keyText={keyText} numericValue={numericValue} progress={transform} pop={pop}/>
      </OperationStage>
      <StateDecorator state={state} consequence={consequence}/>
    </svg>
    {state!=="payoff"&&consequence>0&&keyText&&<div style={{position:"absolute",left:90,right:90,bottom:18,textAlign:"center",fontSize:40,fontWeight:900,color:state==="contradiction"?RED:ACCENT,opacity:Math.min(1,consequence+hold*.2),textShadow:"0 5px 20px #000"}}>{keyText}</div>}
    <div data-motion-phase={hold>0?"hold":consequence>0?"consequence":transform>0?"transform":setup>0?"setup":"idle"} style={{display:"none"}}/>
  </div>;
}

export const RELATIONSHIP_PRIMITIVES: RelationshipPrimitive[] = [
  "network","hierarchy","one-to-many","many-to-one","facets-around-center",
  "overlapping-sets","nested-context","cycle","cause-chain","before-after",
  "map","timeline","quantity","spectrum","physical-transformation",
];

export const ALL_VISUAL_PRIMITIVES: VisualPrimitive[] = [
  "particles","rays","wave","horizon","spectrum","path","shells","objects",
  ...RELATIONSHIP_PRIMITIVES.filter((primitive) => primitive !== "spectrum"),
];
