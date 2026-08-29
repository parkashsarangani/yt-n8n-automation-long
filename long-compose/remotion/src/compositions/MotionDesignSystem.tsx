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

export const MOTION_COMPATIBILITY: Record<VisualOperation, readonly VisualPrimitive[] | readonly ["*"]> = {
  stack: ["particles", "objects", "hierarchy", "nested-context", "quantity", "shells"],
  timeline: ["timeline", "cause-chain", "path", "map", "rays", "wave", "spectrum", "cycle", "particles"],
  counter: ["quantity", "particles", "objects"],
  compress: ["particles", "objects", "many-to-one", "physical-transformation", "before-after", "shells"],
  group: ["network", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context", "particles", "objects"],
  sort: ["objects", "hierarchy", "quantity", "timeline"],
  "scale-compare": ["before-after", "physical-transformation", "spectrum", "quantity", "objects", "overlapping-sets"],
  payoff: ["*"],
};

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
  // Keep a low-amplitude living hold after the main transformation so a
  // diagram never becomes a frozen slide while the final clause is spoken.
  const living = Math.sin(frame / Math.max(1, fps) * Math.PI * 2) * 0.5 + 0.5;
  return { setup, transform, consequence, hold, living, pop };
}

// Wraps into at most two lines, sized to the pill's actual available width
// rather than a fixed character count. A label that still overflows past two
// lines folds its remainder into the second line with an ellipsis instead of
// being dropped outright: the audit's real finding here was that "collision
// resolution" meant deleting the label -- the pill vanished entirely, not
// repositioned or abbreviated -- and a viewer sees no explanation at all
// where one was authored. An ellipsis still tells them what the scene is
// about; a blank space where a label should be tells them nothing.
//
// The bug that made this worse than the audit even realized: the original
// (and my first pass at this rewrite) wrote `lines[lines.length - 1] = word`
// unconditionally. When `lines` is still empty that's `lines[-1] = word` --
// which does not push a real element, since arrays only grow for
// non-negative integer indices -- so the FIRST word of every label was
// silently swallowed on the very next word's turn. A two-word label like
// "cause chain" rendered as just "chain". Caught by actually rendering a
// frame and looking at it, not by the perceptual test, which only checks
// that *some* bright pixels exist in the cell.
// Exported so tests can pin its behaviour directly rather than only through a
// full Chrome render -- the bug this function's history documents (see
// comment below) was invisible to every test that only checked the render
// pipeline end-to-end.
export const labelLines = (text: string, maxChars: number): string[] => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const current = lines.length ? lines[lines.length - 1]! : "";
    if (!current || `${current} ${word}`.length <= maxChars) {
      if (lines.length) lines[lines.length - 1] = `${current} ${word}`;
      else lines.push(word);
      continue;
    }
    if (lines.length < 2) {
      lines.push(word);
      continue;
    }
    const rest = words.slice(i).join(" ");
    const combined = `${lines[1]} ${rest}`;
    lines[1] = combined.length <= maxChars ? combined : `${combined.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
    break;
  }
  return lines;
};

function Label({ text, x, y, active = false, state, maxWidth = 300 }: { text?: string; x: number; y: number; active?: boolean; state: VisualState; maxWidth?: number }) {
  if (!text) return null;
  const colors = palette[state];
  // ~0.56em per character at this weight; derived from maxWidth so a wider
  // pill (a full-model scene) actually wraps later than a narrow one (a dense
  // row slot), instead of every pill wrapping at the same fixed character
  // count regardless of how much room it was actually given.
  const lines = labelLines(text, Math.max(10, Math.floor((maxWidth - 38) / (54 * 0.56))));
  if (!lines.length) return null;
  const longest = Math.max(...lines.map((line) => line.length));
  const fontSize = Math.max(47, Math.min(54, (maxWidth - 38) / Math.max(4, longest) * 1.72));
  const width = Math.min(maxWidth, Math.max(150, longest * fontSize * 0.58 + 44));
  const height = lines.length === 2 ? 96 : 72;
  return <g transform={`translate(${x} ${y})`}>
    <rect x={-width / 2} y={-height / 2} width={width} height={height} rx="22" fill={active ? colors.fill : "#0B1424"} stroke={active ? colors.line : colors.muted} strokeWidth={active ? 4 : 2} />
    <text textAnchor="middle" fill={PAPER} fontSize={fontSize} fontWeight="820">
      {lines.map((line, index) => <tspan key={`${line}-${index}`} x="0" y={(index - (lines.length - 1) / 2) * fontSize * 1.02 + fontSize * 0.34}>{line}</tspan>)}
    </text>
  </g>;
}

const hashText = (text: string) => Array.from(text).reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 2166136261);

// Six silhouettes (not four) so a viewer tracking several entities across a
// crowded network/timeline sees genuinely distinct marks rather than the same
// four shapes repeating and reading as generic "pills and nodes". Hexagon and
// plus were picked specifically because their outlines differ from the
// existing circle/diamond/triangle/ring at a glance, even at small size.
function EntityMark({ id, x, y, size = 30, active = true }: { id: string; x: number; y: number; size?: number; active?: boolean }) {
  const hash = hashText(id || "entity");
  const colors = [ACCENT, BLUE, GREEN, "#B794F4", "#FF7D7D", "#5DE0C6"];
  const fill = colors[hash % colors.length]!;
  const shape = Math.floor(hash / colors.length) % 6;
  const opacity = active ? 1 : 0.25;
  if (shape === 0) return <circle cx={x} cy={y} r={size} fill={fill} opacity={opacity} />;
  if (shape === 1) return <rect x={x-size} y={y-size} width={size*2} height={size*2} rx={size*.25} fill={fill} opacity={opacity} transform={`rotate(45 ${x} ${y})`} />;
  if (shape === 2) return <polygon points={`${x},${y-size} ${x+size},${y+size*.8} ${x-size},${y+size*.8}`} fill={fill} opacity={opacity} />;
  if (shape === 3) return <circle cx={x} cy={y} r={size} fill="none" stroke={fill} strokeWidth={Math.max(6, size*.28)} opacity={opacity} />;
  if (shape === 4) {
    const hexPoints = Array.from({ length: 6 }, (_, i) => {
      const angle = Math.PI / 6 + (i * Math.PI) / 3;
      return `${x + Math.cos(angle) * size},${y + Math.sin(angle) * size}`;
    }).join(" ");
    return <polygon points={hexPoints} fill={fill} opacity={opacity} />;
  }
  const arm = size * 0.62;
  return <path d={`M${x-arm} ${y-size} L${x+arm} ${y-size} L${x+arm} ${y-arm} L${x+size} ${y-arm} L${x+size} ${y+arm} L${x+arm} ${y+arm} L${x+arm} ${y+size} L${x-arm} ${y+size} L${x-arm} ${y+arm} L${x-size} ${y+arm} L${x-size} ${y-arm} L${x-arm} ${y-arm} Z`} fill={fill} opacity={opacity} />;
}

// A diagram gets at most one central label plus two supporting labels. Watch
// feedback on a rendered episode found the opposite problem from an earlier
// audit round: four simultaneous labels read as competing clutter, even
// though each one individually had a collision-free slot. One entity mattering
// more than the others is also just true of most explanations -- a cause
// chain has a beginning and an end that carry the weight; the middle steps
// are what the geometry (edges, motion) is for. The uncaptioned entities keep
// their EntityMark shape/colour, so the viewer still sees all of them; they
// just aren't all narrated in text at once.
const MAX_LABELS = 3;

// Three fixed, non-overlapping slots -- a peak and two flanking positions --
// rather than tying a label to its operated entity: an operation like payoff
// can move two entities to the same x, which would stack two labels exactly
// on top of each other if the slot followed the entity instead of the row.
const DENSE_SLOTS = [
  { x: 540, y: 340 },
  { x: 270, y: 436 },
  { x: 810, y: 436 },
] as const;
const denseLabelSlot = (index: number) => DENSE_SLOTS[index] ?? DENSE_SLOTS[2]!;

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

type Point = [number, number];

function operatePoint(base: Point, index: number, total: number, operation: VisualOperation, progress: number): Point {
  let target: Point = base;
  if (operation === "stack") {
    target = [420 + (index % 6) * 48, 430 - Math.floor(index / 6) * 48];
  } else if (operation === "group") {
    const center: Point = index % 2 === 0 ? [350, 245] : [730, 245];
    target = [center[0] + ((index * 37) % 120) - 60, center[1] + ((index * 53) % 150) - 75];
  } else if (operation === "sort") {
    const rank = total - 1 - index;
    target = [170 + (rank % 5) * 185, 115 + Math.floor(rank / 5) * 115];
  } else if (operation === "compress") {
    target = [540 + (base[0] - 540) * 0.32, 245 + (base[1] - 245) * 0.38];
  } else if (operation === "scale-compare") {
    const left = index < total / 2;
    target = [left ? 260 + (base[0] % 180) : 710 + (base[0] % 230), 245 + (base[1] - 245) * (left ? 0.58 : 1.12)];
  } else if (operation === "payoff") {
    const angle = total > 1 ? index / total * Math.PI * 2 : 0;
    target = [540 + Math.cos(angle) * 160, 245 + Math.sin(angle) * 125];
  }
  return [
    base[0] + (target[0] - base[0]) * progress,
    base[1] + (target[1] - base[1]) * progress,
  ];
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
  ];
}

type GeometryProps = {
  primitive: VisualPrimitive;
  operation: VisualOperation;
  state: VisualState;
  labels: string[];
  identityKeys: string[];
  before: string;
  after: string;
  keyText: string;
  numericValue: number | null;
  progress: number;
  living: number;
  pop: (delay?: number) => number;
};

function Geometry({ primitive, operation, state, labels, identityKeys, before, after, keyText, numericValue, progress, living, pop }: GeometryProps) {
  const colors = palette[state];
  const commonStroke = { fill: "none", stroke: colors.line, strokeWidth: 7, strokeLinecap: "round" as const, strokeDasharray: state === "hypothesis" ? "15 12" : undefined };

  if (primitive === "particles") {
    // Every other primitive separates hypothesis from contradiction
    // structurally, via dashed strokes on provisional geometry. Particles had
    // only a palette change, so two states rendered with identical structure:
    // invisible to a perceptual comparison, and weak for a viewer too.
    const provisional = state === "hypothesis";
    const broken = state === "contradiction";
    return <>{Array.from({ length: 28 }, (_, i) => {
      const base: Point = [105 + (i % 7) * 142, 82 + Math.floor(i / 7) * 110];
      const [ox, oy] = operatePoint(base, i, 28, operation, progress);
      // Contradiction scatters the particles that carried the failed guess, so
      // the break reads in the arrangement rather than only in the colour.
      const x = ox + (broken ? Math.sin(i * 2.1) * 34 * progress : 0);
      const y = oy + (broken ? Math.cos(i * 1.7) * 26 * progress : 0);
      const activated = operation !== "counter" || i < Math.ceil(28 * progress);
      const radius = (10 + pop(i * 0.025) * 13) * (activated ? 1 : 0.52);
      const opacity = activated ? 0.3 + progress * 0.7 : 0.12;
      const fill = i % 4 === 0 ? ACCENT : colors.line;
      // Hypothesis draws the same particles as unfilled dashed rings: present,
      // but not yet asserted.
      if (provisional) {
        return <circle key={i} cx={x} cy={y} r={radius} fill="none" stroke={fill} strokeWidth="3" strokeDasharray="6 6" opacity={opacity} />;
      }
      return <Dot key={i} x={x} y={y} r={radius + living * 1.5} fill={fill} opacity={opacity} />;
    })}</>;
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
    return <><circle cx="540" cy="245" r={70+progress*130} {...commonStroke}/><circle cx="540" cy="245" r="30" fill={ACCENT}/><path d="M90 245 H990" {...commonStroke} opacity=".55"/><Label text={after||labels[0]} x={540} y={445} active state={state}/></>;
  }
  if (primitive === "spectrum") {
    const comparing = operation === "scale-compare";
    const leftWidth = comparing ? 310 - progress * 105 : 900;
    const rightWidth = comparing ? 310 + progress * 105 : 0;
    return <><defs><linearGradient id="motion-spectrum"><stop stopColor="#7447FF"/><stop offset=".35" stopColor="#3C8DFF"/><stop offset=".65" stopColor="#E9E45D"/><stop offset="1" stopColor="#E84E4E"/></linearGradient></defs>
      <rect x={comparing ? 120 : 90} y={comparing ? 135 : 185} width={leftWidth} height="100" rx="50" fill="url(#motion-spectrum)" opacity=".9"/>
      {comparing ? <rect x="620" y="285" width={rightWidth} height="100" rx="50" fill="url(#motion-spectrum)" opacity=".9"/> : <line x1={90+progress*900} y1="145" x2={90+progress*900} y2="335" stroke={PAPER} strokeWidth="9"/>}
      <Label text={before||labels[0]} x={comparing ? 280 : 210} y={comparing ? 285 : 390} state={state}/><Label text={after||labels[1]} x={comparing ? 790 : 870} y={comparing ? 435 : 390} active state={state}/></>;
  }
  if (primitive === "path") {
    const curve: [Point, Point, Point, Point] = [[95,390],[250,55],[720,55],[985,330]];
    const marker = cubicPoint(curve[0], curve[1], curve[2], curve[3], progress);
    const d = `M${curve[0][0]} ${curve[0][1]} C${curve[1][0]} ${curve[1][1]} ${curve[2][0]} ${curve[2][1]} ${curve[3][0]} ${curve[3][1]}`;
    return <><path d={d} {...commonStroke} opacity=".45"/>
      <path d={d} {...commonStroke} pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress}/>
      <Dot x={marker[0]} y={marker[1]} r={22} fill={ACCENT}/><Label text={keyText||labels[0]} x={540} y={455} active state={state}/></>;
  }
  if (primitive === "shells") {
    const centers=Array.from({length:4},(_,i)=>operatePoint([540,245],i,4,operation,progress));
    return <>{centers.map(([x,y],i)=><circle key={i} cx={x} cy={y} r={65+i*58*progress} {...commonStroke} opacity={.35+i*.15}/>)}
      <Dot x={centers[0]![0]} y={centers[0]![1]} r={32} fill={ACCENT}/><Label text={labels[0]||keyText} x={540} y={455} active state={state}/></>;
  }
  if (primitive === "objects") {
    const entities = labels.slice(0,4);
    return <>{entities.map((label,i)=>{const total=Math.max(1,entities.length);const [x,y]=operatePoint([190+(i%2)*700,145+Math.floor(i/2)*210],i,total,operation,progress);const activated=operation!=="counter"||i<Math.ceil(total*progress);return <g key={`${label}-${i}`} opacity={activated?1:.16}><EntityMark id={identityKeys[i]||label} x={x} y={y-22} size={46 + living * 2} active={activated}/>{i<2 ? <Label text={label} x={x} y={y+70} active={activated&&i===Math.floor(progress*total)} state={state} maxWidth={340}/> : null}</g>})}</>;
  }
  if (primitive === "network") {
    const bases: Point[]=[[160,125],[390,80],[700,105],[925,210],[780,400],[470,385],[150,325]];
    const nodes = bases.map((point, i) => operatePoint(point, i, bases.length, operation, progress));
    const links: Array<[number,number]>=[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0],[1,5],[2,4],[0,5]];
    return <>{links.map(([a,b],i)=><DirectedEdge key={i} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} progress={Math.max(0,progress-i*.045)} state={state}/>)}
      {nodes.map(([x,y],i)=><EntityMark key={i} id={identityKeys[i] || labels[i] || `entity-${i}`} x={x} y={y} size={18+pop(i*.04)*9}/>)}</>;
  }
  if (primitive === "hierarchy") {
    const childBases: Point[]=[[210,380],[430,380],[650,380],[870,380]];
    const children=childBases.map((point,i)=>operatePoint(point,i,childBases.length,operation,progress));
    return <><Label text={labels[0]||"Root"} x={540} y={85} active state={state}/>
      <DirectedEdge x1={540} y1={120} x2={330} y2={230} progress={progress} state={state}/><DirectedEdge x1={540} y1={120} x2={750} y2={230} progress={progress} state={state}/>
      <Dot x={330} y={245} r={34} fill={BLUE}/><Dot x={750} y={245} r={34} fill={BLUE}/>
      {children.map(([x,y],i)=><React.Fragment key={i}><DirectedEdge x1={i<2?330:750} y1={270} x2={x} y2={y-25} progress={Math.max(0,progress-.18)} state={state}/><Dot x={x} y={y} r={25} fill={ACCENT}/></React.Fragment>)}</>;
  }
  if (primitive === "one-to-many") {
    const targets: Array<[number,number]>=[[850,85],[920,180],[940,300],[860,410]];
    return <><Label text={labels[0]||before} x={220} y={245} active state={state}/>{targets.map((base,i)=>{const [x,y]=operatePoint(base,i,targets.length,operation,progress);return <React.Fragment key={i}><DirectedEdge x1={352} y1={245} x2={x-30} y2={y} progress={Math.max(0,progress-i*.08)} state={state}/><Dot x={x} y={y} r={24} fill={i%2?BLUE:ACCENT}/></React.Fragment>})}</>;
  }
  if (primitive === "many-to-one") {
    const sources: Array<[number,number]>=[[150,85],[90,180],[80,300],[160,410]];
    return <>{sources.map((base,i)=>{const [x,y]=operatePoint(base,i,sources.length,operation,progress);return <React.Fragment key={i}><Dot x={x} y={y} r={24} fill={i%2?BLUE:ACCENT}/><DirectedEdge x1={x+30} y1={y} x2={720} y2={245} progress={Math.max(0,progress-i*.08)} state={state}/></React.Fragment>})}<Label text={after||labels[0]} x={850} y={245} active state={state}/></>;
  }
  if (primitive === "facets-around-center") {
    const facets: Array<[number,number]>=[[540,65],[820,150],[820,350],[540,430],[260,350],[260,150]];
    return <>{facets.map((base,i)=>{const [x,y]=operatePoint(base,i,facets.length,operation,progress);return <React.Fragment key={i}><path d={`M540 245 L${x} ${y}`} {...commonStroke} opacity={.4+progress*.5}/><polygon points={`${x},${y-30} ${x+34},${y} ${x},${y+30} ${x-34},${y}`} fill={i%2?BLUE:ACCENT} opacity={.68+progress*.32}/></React.Fragment>})}
      <circle cx="540" cy="245" r="84" fill={colors.fill} stroke={colors.line} strokeWidth="8"/><Label text={labels[0]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "overlapping-sets") {
    const spread=105*(1-progress);
    const compare=operation==="scale-compare"?progress:0;
    return <><circle cx={430-spread} cy="245" r={180-compare*55} fill="#65C7F733" stroke={BLUE} strokeWidth="7"/><circle cx={650+spread} cy="245" r={180+compare*45} fill="#FFD16633" stroke={ACCENT} strokeWidth="7"/>
      <Label text={labels[0]} x={320-spread} y={245} state={state} maxWidth={250}/><Label text={labels[1]} x={760+spread} y={245} state={state} maxWidth={250}/></>;
  }
  if (primitive === "nested-context") {
    const sizes=[360,280,200,120];
    const centers=sizes.map((_,i)=>operatePoint([540,245],i,sizes.length,operation,progress));
    return <>{sizes.map((size,i)=>{const [x,y]=centers[i]!;return <rect key={i} x={x-size*progress/2} y={y-size*progress/2} width={size*progress} height={size*progress} rx={30+i*5} fill={i===3?colors.fill:"none"} stroke={i===0?colors.line:colors.muted} strokeWidth={i===0?8:4}/>})}
      <Label text={labels[0]||keyText} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "cycle") {
    const pts: Array<[number,number]>=[[540,70],[850,245],[540,420],[230,245]];
    const moved=pts.map((point,i)=>operatePoint(point,i,pts.length,operation,progress));
    return <>{moved.map(([x,y],i)=>{const next=moved[(i+1)%moved.length]!;return <React.Fragment key={i}><DirectedEdge x1={x} y1={y} x2={next[0]} y2={next[1]} progress={Math.max(0,progress-i*.12)} state={state} curved/><Dot x={x} y={y} r={31} fill={i%2?BLUE:ACCENT}/></React.Fragment>})}<Label text={keyText||labels[0]} x={540} y={245} active state={state}/></>;
  }
  if (primitive === "cause-chain") {
    const bases: Point[]=[[120,245],[385,245],[650,245],[920,245]];
    const points=bases.map((point,i)=>operatePoint(point,i,bases.length,operation,progress));
    // denseLabelSlot places up to 4 entities on distinct, non-overlapping
    // positions (2x2), so there is no spatial reason to label only the first
    // two of up to four accepted entities -- that left the back half of the
    // chain, where the consequence and resolution actually sit, unlabeled.
    return <>{points.map(([x,y],i)=>{const next=points[i+1];return <React.Fragment key={i}>{next&&<DirectedEdge x1={x+40} y1={y} x2={next[0]-40} y2={next[1]} progress={Math.max(0,progress-i*.16)} state={state}/>}<EntityMark id={identityKeys[i]||labels[i]||`step-${i}`} x={x} y={y} size={30+pop(i*.12)*10}/><Label text={labels[i]} {...denseLabelSlot(i)} active={i===Math.min(MAX_LABELS-1,Math.floor(progress*4))} state={state} maxWidth={260}/></React.Fragment>})}</>;
  }
  if (primitive === "before-after") {
    const leftWidth=390*(operation==="scale-compare"?1-progress*.28:1);
    const rightWidth=390*(operation==="scale-compare"?1+progress*.28:1);
    const inward=operation==="compress"?progress*105:0;
    return <><rect x={90+inward} y="100" width={leftWidth} height="290" rx="34" fill={colors.fill} stroke={colors.muted} strokeWidth="6"/><rect x={990-inward-rightWidth} y="100" width={rightWidth} height="290" rx="34" fill={colors.fill} stroke={colors.line} strokeWidth="8" opacity={.3+progress*.7}/>
      <Label text={before||labels[0]} x={90+inward+leftWidth/2} y={245} state={state}/><DirectedEdge x1={490} y1={245} x2={585} y2={245} progress={progress} state={state}/><Label text={after||labels[1]} x={990-inward-rightWidth/2} y={245} active state={state}/></>;
  }
  if (primitive === "map") {
    const places: Array<[number,number]>=[[130,360],[315,135],[520,305],[735,110],[950,340]];
    return <><path d="M70 410 Q210 40 385 250 T690 210 T1010 355" fill="none" stroke={colors.muted} strokeWidth="30" opacity=".4"/>
      {places.map((base,i)=>{const moved=places.map((point,j)=>operatePoint(point,j,places.length,operation,progress));const [x,y]=moved[i]!;return <React.Fragment key={i}>{i<moved.length-1&&<DirectedEdge x1={x} y1={y} x2={moved[i+1]![0]} y2={moved[i+1]![1]} progress={Math.max(0,progress-i*.13)} state={state}/>}<g transform={`translate(${x} ${y}) scale(.55)`}><path d="M0 0 c-20-30-45-5-45 17 0 33 45 68 45 68s45-35 45-68c0-22-25-47-45-17z" fill={i===places.length-1?GREEN:ACCENT}/></g></React.Fragment>})}</>;
  }
  if (primitive === "timeline") {
    const bases: Point[]=[[130,245],[350,245],[570,245],[790,245],[970,245]];
    const points=bases.map((point,i)=>operatePoint(point,i,bases.length,operation,progress));
    // Same reasoning as cause-chain: up to 4 labelled entities all have a
    // distinct, collision-free denseLabelSlot, so the back half of the
    // timeline was withheld from viewers for no spatial reason.
    return <><path d={`M${points.map(([x,y])=>`${x} ${y}`).join(" L")}`} {...commonStroke} opacity=".5"/>{points.map(([x,y],i)=><React.Fragment key={i}><line x1={x} y1={y-50} x2={x} y2={y+50} stroke={i/4<=progress?colors.line:colors.muted} strokeWidth="8"/><EntityMark id={identityKeys[i]||labels[i]||`moment-${i}`} x={x} y={y} size={i/4<=progress?24:12} active={i/4<=progress}/><Label text={labels[i]} {...denseLabelSlot(i)} active={i===Math.min(MAX_LABELS-1,Math.floor(progress*5))} state={state} maxWidth={260}/></React.Fragment>)}</>;
  }
  if (primitive === "quantity") {
    if (numericValue === null) throw new Error("quantity primitive requires an explicit numericValue");
    const target = numericValue;
    const dots = Math.max(5, Math.min(60, Math.round(target)));
    const active = Math.round(dots*progress);
    return <>{Array.from({length:dots},(_,i)=>{const [x,y]=operatePoint([120+(i%10)*92,90+Math.floor(i/10)*65],i,dots,operation,progress);return <Dot key={i} x={x} y={y} r={i<active?22:11} fill={i<active?colors.line:colors.muted} opacity={i<active?1:.25}/>})}
      <text x="540" y="430" textAnchor="middle" fill={PAPER} fontSize="92" fontWeight="900">{Math.round(target*progress).toLocaleString()}</text></>;
  }
  if (primitive === "physical-transformation") {
    // Had no branch of its own, so it fell through to the generic default
    // below and drew the same rotating slab as any unhandled primitive -- two
    // different authored primitives rendering as one picture.
    //
    // Deliberately not before-after: that primitive cuts between two finished
    // panels, this one keeps a single body of matter on screen and reorganises
    // it in place, so the viewer watches the conversion rather than comparing
    // two end states.
    const grains = 27;
    const provisional = state === "hypothesis";
    const broken = state === "contradiction";
    return <><rect x="150" y="104" width="780" height="248" rx={26 + progress * 96} fill={colors.fill} stroke={colors.line} strokeWidth="7" opacity={.42 + progress * .38} />
      {Array.from({ length: grains }, (_, i) => {
        const lattice: Point = [236 + (i % 9) * 68, 160 + Math.floor(i / 9) * 62];
        // The loosening is the point: grains leave their lattice site as the
        // conversion proceeds, then the operation places them.
        const loosened: Point = [lattice[0] + Math.sin(i * 1.7) * 52 * progress, lattice[1] + Math.cos(i * 2.3) * 44 * progress];
        const [ox, oy] = operatePoint(loosened, i, grains, operation, progress);
        const x = ox + (broken ? Math.sin(i * 2.6) * 30 * progress : 0);
        const y = oy + (broken ? Math.cos(i * 1.9) * 24 * progress : 0);
        const radius = 14 - progress * 5;
        const opacity = .4 + pop(i * .018) * .6;
        const fill = i % 4 === 0 ? ACCENT : colors.line;
        if (provisional) return <circle key={i} cx={x} cy={y} r={radius} fill="none" stroke={fill} strokeWidth="3" strokeDasharray="6 6" opacity={opacity} />;
        return <Dot key={i} x={x} y={y} r={radius} fill={fill} opacity={opacity} />;
      })}
      <Label text={before || labels[0]} x={260} y={430} state={state} />
      <DirectedEdge x1={440} y1={430} x2={640} y2={430} progress={progress} state={state} />
      <Label text={after || labels[1] || keyText} x={820} y={430} active state={state} /></>;
  }
  const physicalScale=operation==="scale-compare"?0.72+progress*.55:operation==="compress"?1-progress*.42:1;
  return <><g transform={`translate(540 245) rotate(${progress*180}) scale(${physicalScale})`}><rect x="-170" y="-100" width="340" height="200" rx={20+progress*50} fill={colors.fill} stroke={colors.line} strokeWidth="8"/><circle r={progress*90} fill={GREEN} opacity={progress*.55}/></g>
    <Label text={before||labels[0]} x={260} y={430} state={state}/><Label text={after||labels[1]||keyText} x={820} y={430} active state={state}/></>;
}

function OperationStage({ operation, progress, living, state, numericValue, children }: { operation: VisualOperation; progress: number; living: number; state: VisualState; numericValue: number | null; children: React.ReactNode }) {
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
  // .62 floor, not .35: this wraps every scene's entire geometry, so the old
  // floor meant every scene opened at 35% opacity against a near-black
  // background until the transform ramped up -- watch feedback specifically
  // called out the opening's model as "almost invisible", and the first
  // frames of every other scene had the same problem, just less noticed
  // since the opening is what a viewer judges first.
  return <g transform={`${transform} translate(0 ${living * 2 - 1})`} opacity={.62+progress*.38}>
    {operation === "timeline" ? <g clipPath="url(#operation-reveal)">{children}</g> : children}
    {operation === "counter" && numericValue !== null && <text x="1000" y="92" textAnchor="end" fill={colors.line} fontSize="64" fontWeight="900">{Math.round(numericValue*progress).toLocaleString()}</text>}
    {operation === "compress" && <><path d={`M${80+progress*165} 170 v150`} stroke={colors.line} strokeWidth="10"/><path d={`M${1000-progress*165} 170 v150`} stroke={colors.line} strokeWidth="10"/></>}
    {operation === "scale-compare" && <><line x1="140" y1="440" x2={140+progress*300} y2="440" stroke={ACCENT} strokeWidth="12"/><line x1="620" y1="440" x2={620+progress*380} y2="440" stroke={GREEN} strokeWidth="12"/></>}
    {operation === "payoff" && <circle cx="540" cy="245" r={170+progress*80} fill="none" stroke={GREEN} strokeWidth="8" opacity={.15+progress*.5}/>}
  </g>;
}

function StateDecorator({ state, consequence }: { state: VisualState; consequence: number }) {
  if (state === "hypothesis") return <g opacity={.25+consequence*.75}><rect x="48" y="48" width="984" height="414" rx="52" fill="none" stroke="#E8B96A" strokeWidth="5" strokeDasharray="16 14"/><circle cx="980" cy="80" r="34" fill="#3B2E22" stroke="#E8B96A" strokeWidth="5"/><text x="980" y="92" textAnchor="middle" fill={PAPER} fontSize="38" fontWeight="900">?</text></g>;
  if (state === "contradiction") return <g opacity={consequence}><path d="M470 170 l55 55 -40 55 70 70" fill="none" stroke={RED} strokeWidth="16" strokeLinecap="round"/><path d="M610 155 l-45 70 50 45 -55 80" fill="none" stroke={RED} strokeWidth="10" strokeLinecap="round"/></g>;
  if (state === "qualification") return <rect x="48" y="48" width="984" height="414" rx="52" fill="none" stroke="#B794F4" strokeWidth="6" strokeDasharray="18 14" opacity={.3+consequence*.65}/>;
  // No payoff ring here: ExplanationScene's own PayoffResolution overlay draws
  // the canonical unifying ring on top of everything. Both firing at once was
  // a literal duplicate circle competing with the payoff caption for
  // attention -- this is the model's copy of a decoration the composition
  // layer already owns.
  return null;
}

export function MotionDesignSystem({ primitive, operation = "timeline", state = "mechanism", numericValue = null, elements = [], entityIdentityKeys = [], before = "", after = "", keyText = "", diagnosticMode = "normal" }: {
  primitive: VisualPrimitive; operation?: VisualOperation; state?: VisualState; numericValue?: number | null; elements?: string[]; entityIdentityKeys?: string[]; before?: string; after?: string; keyText?: string;
  diagnosticMode?: "normal" | "foreground-only" | "background-only";
}) {
  const { setup, transform, consequence, hold, living, pop } = useProgress();
  if ((operation === "counter" || primitive === "quantity") && (numericValue === null || !Number.isFinite(numericValue))) {
    throw new Error(`${operation}/${primitive} requires an explicit numericValue`);
  }
  // Identity labels come only from model elements. Before/after remain owned
  // by comparison primitives instead of being appended as duplicate pills.
  // Capped at MAX_LABELS (one central, two supporting) regardless of
  // primitive: more than that reads as competing clutter rather than a
  // legible diagram, even when every label individually has its own slot.
  //
  // entityIdentityKeys (parallel to elements, by index) is a proxy identity
  // for the SAME entity across scenes even when its display wording changes
  // -- it seeds EntityMark's shape/colour hash instead of the raw label text,
  // so "the cell" and "this structure" (same underlying entity, different
  // words) render as the same mark rather than two unrelated ones. This does
  // not solve cross-scene identity in general (that needs an authored
  // canonical entity list the planner doesn't emit yet); it only keeps a
  // single scene's marks stable when the compiler already supplies keys.
  const visibleEntities = state === "payoff" ? [] : (() => {
    const seen = new Set<string>();
    const pairs: Array<{ label: string; identity: string }> = [];
    elements.forEach((el, i) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      pairs.push({ label: el, identity: entityIdentityKeys[i] || el.toLowerCase() });
    });
    return pairs.slice(0, operation === "timeline" || primitive === "cause-chain" ? MAX_LABELS : 2);
  })();
  const labels = visibleEntities.map((e) => e.label);
  const identityKeys = visibleEntities.map((e) => e.identity);
  // Several Geometry branches fall back to keyText/before/after when their
  // own labels array is empty (`labels[0] || keyText`, and similar) -- exactly
  // what payoff leaves empty. Left unguarded, the model kept drawing its own
  // copy of the same phrase PayoffResolution renders as the large closing
  // statement: the diagram and the overlay said the same thing twice, and the
  // diagram's copy sat underneath at low opacity as a ghost the audit
  // specifically called out ("underlying diagram text remains visible").
  const isPayoffState = state === "payoff";
  const geometryKeyText = isPayoffState ? "" : keyText;
  const geometryBefore = isPayoffState ? "" : before;
  const geometryAfter = isPayoffState ? "" : after;
  const colors = palette[state];
  const foregroundVisible = diagnosticMode !== "background-only";
  const backgroundVisible = diagnosticMode !== "foreground-only";
  return <div style={{ position:"relative", width:"100%", height:510, borderRadius:36, overflow:"hidden", boxShadow:diagnosticMode==="normal"?"0 24px 70px #0008":"none" }}>
    <svg viewBox="0 0 1080 510" style={{ width:"100%", height:"100%", display:"block" }}>
      <defs>
        <marker id="motion-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill={colors.line}/></marker>
        <clipPath id="operation-reveal"><rect x="0" y="0" width={1080*transform} height="510"/></clipPath>
      </defs>
      {backgroundVisible ? <rect x="12" y="12" width="1056" height="486" rx="34" fill={BG} stroke={colors.muted} strokeWidth="2" opacity="0.96" /> : null}
      {foregroundVisible ? <OperationStage operation={operation} progress={transform} living={living} state={state} numericValue={numericValue}>
        {state === "contradiction" ? <>
          <g opacity={1-consequence}><Geometry primitive={primitive} operation={operation} state="hypothesis" labels={labels} identityKeys={identityKeys} before={before} after={after} keyText={keyText} numericValue={numericValue} progress={transform} living={living} pop={pop}/></g>
          <g opacity={consequence}><Geometry primitive={primitive} operation={operation} state="contradiction" labels={labels} identityKeys={identityKeys} before={before} after={after} keyText={keyText} numericValue={numericValue} progress={transform} living={living} pop={pop}/></g>
        </> : <Geometry primitive={primitive} operation={operation} state={state} labels={labels} identityKeys={identityKeys} before={geometryBefore} after={geometryAfter} keyText={geometryKeyText} numericValue={numericValue} progress={transform} living={living} pop={pop}/>}
      </OperationStage> : null}
      {foregroundVisible ? <StateDecorator state={state} consequence={consequence}/> : null}
    </svg>
    {foregroundVisible&&state==="contradiction"&&consequence>0&&keyText&&<div style={{position:"absolute",left:150,right:150,bottom:20,textAlign:"center",fontSize:36,fontWeight:900,color:RED,opacity:Math.min(1,consequence+hold*.2),textShadow:"0 5px 20px #000"}}>{labelLines(keyText, 32).flat().slice(0,1)}</div>}
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
