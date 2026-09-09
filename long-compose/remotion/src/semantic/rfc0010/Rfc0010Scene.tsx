import {useCurrentFrame, useVideoConfig} from "remotion";
import {fitText} from "./text-fit";
import type {Rfc0010Axis, Rfc0010Edge, Rfc0010Marker, Rfc0010Node, Rfc0010Scene} from "./types";

export const W = 1920;
export const H = 1080;
export const SAFE_X = 150;
export const SAFE_TOP = 96;
export const SAFE_BOTTOM = 984;
export const SAFE_W = W - SAFE_X * 2;
const BG = "#08101E";
const PAPER = "#F7F4EA";
const MUTED = "#9FB2C9";
const ACCENT = "#FFD166";
const GREEN = "#7DE2A8";
const BLUE = "#65C7F7";
const TEAL = "#56D6C9";
const VIOLET = "#B79CFF";
const RED = "#FF8C8C";
const SERIES = [BLUE, GREEN, ACCENT, VIOLET, TEAL, RED];

const ENTRANCE_START = 0.1;
const ENTRANCE_DURATION = 0.3;
const ENTRANCE_SETTLED = 0.9;

function progress(): number {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  return Math.max(0, Math.min(1, frame / Math.max(1, durationInFrames - 1)));
}
function ease(t: number): number { return t < .5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2; }
function color(i: number): string { return SERIES[i % SERIES.length]!; }

/**
 * Deterministic entrance staging for one marker / node / edge of a semantic
 * scene.
 *
 * Pure: a function only of the scene's normalised progress `r` in [0,1],
 * whether this element was already established by an earlier cumulative beat
 * (`retained`), and its `index` of `count`. No RNG, no wall clock — every
 * render of a given beat frame produces the same geometry.
 *
 *  - `retained` elements are drawn already-complete and never re-animate.
 *  - elements arrive staggered (earlier index leads); the stagger compresses as
 *    `count` grows so every element is fully settled by `ENTRANCE_SETTLED`,
 *    i.e. nothing is still moving — or missing — at the cut.
 *
 * Self-contained (the easing is inlined, not a call to `ease`) and exported so
 * the long-compose contract suite can slice this function out and exercise the
 * real arithmetic without a full Remotion render.
 */
export function entrance(r: number, retained: boolean | undefined, index: number, count: number): number {
  if (retained) return 1;
  const last = ENTRANCE_SETTLED - ENTRANCE_DURATION;
  const stagger = count > 1 ? Math.min(0.18, (last - ENTRANCE_START) / (count - 1)) : 0;
  const start = ENTRANCE_START + index * stagger;
  const t = Math.max(0, Math.min(1, (r - start) / ENTRANCE_DURATION));
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function FittedText({text,x,y,maxWidth,fontSize,maxLines=2,fill=PAPER,weight=800,anchor="middle",opacity=1}:{text:string;x:number;y:number;maxWidth:number;fontSize:number;maxLines?:number;fill?:string;weight?:number;anchor?:"start"|"middle"|"end";opacity?:number}) {
  const f=fitText(text,maxWidth,fontSize,maxLines); if(!f.lines.length) return null;
  return <text x={x} y={y} fill={fill} fontSize={f.fontSize} fontWeight={weight} textAnchor={anchor} opacity={opacity} style={{fontFamily:"Inter,Arial,sans-serif"}}>{f.lines.map((line,i)=><tspan key={i} x={x} dy={i===0?0:f.fontSize*1.16}>{line}</tspan>)}</text>;
}
function Frame({children,blueprint}:{children:React.ReactNode;blueprint:string}) {
  return <svg data-rfc0010-scene={blueprint} viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100%",display:"block",background:BG}}>
    <defs><radialGradient id="vignette" cx="50%" cy="44%" r="72%"><stop offset="0%" stopColor="#17334D" stopOpacity=".55"/><stop offset="100%" stopColor={BG} stopOpacity="0"/></radialGradient><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill={ACCENT}/></marker></defs>
    <rect width={W} height={H} fill={BG}/><rect width={W} height={H} fill="url(#vignette)"/>{children}
  </svg>;
}
function Caption({scene}:{scene:Rfc0010Scene}) { return <FittedText text={scene.caption} x={W/2} y={SAFE_TOP+66} maxWidth={SAFE_W} fontSize={60} maxLines={2}/>; }
function NodeBox({node,x,y,w=300,h=150,index=0,opacity=1}:{node:Rfc0010Node;x:number;y:number;w?:number;h?:number;index?:number;opacity?:number}) {
  return <g opacity={opacity} data-entity-id={node.id}><rect x={x-w/2} y={y-h/2} width={w} height={h} rx={28} fill="#12294A" stroke={color(index)} strokeWidth={6}/><FittedText text={node.label} x={x} y={y-2} maxWidth={w-42} fontSize={40} maxLines={2} weight={850}/>{node.sub_label?<FittedText text={node.sub_label} x={x} y={y+h/2-22} maxWidth={w-38} fontSize={27} maxLines={1} fill={MUTED} weight={650}/>:null}</g>;
}
function Arrow({x1,y1,x2,y2,label,opacity=1}:{x1:number;y1:number;x2:number;y2:number;label?:string;opacity?:number}) {
  const mx=(x1+x2)/2,my=(y1+y2)/2;
  return <g opacity={opacity}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ACCENT} strokeWidth={7} markerEnd="url(#arrow)"/>{label?<FittedText text={label} x={mx} y={my-18} maxWidth={260} fontSize={28} maxLines={1} fill={MUTED} weight={700}/>:null}</g>;
}

function ScaleComparison({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), axis=scene.axis as Rfc0010Axis, markers=(scene.markers??[]).slice(0,4); const left=610,right=1710,span=right-left,first=330,gap=135,axisY=first+markers.length*gap;
  return <Frame blueprint="scale_comparison"><Caption scene={scene}/>{markers.map((m,i)=>{const y=first+i*gap,t=entrance(r,m.retained,i,markers.length),x=left+span*Math.max(0,Math.min(1,m.value/axis.max))*t;return <g key={m.id} data-entity-id={m.id}><FittedText text={m.label} x={left-45} y={y+10} maxWidth={390} fontSize={38} maxLines={2} anchor="end" fill={color(i)}/><line x1={left} y1={y} x2={right} y2={y} stroke="#22385A" strokeWidth={9}/><line x1={left} y1={y} x2={x} y2={y} stroke={color(i)} strokeWidth={9}/><circle cx={x} cy={y} r={18} fill={color(i)}/>{m.rate_label?<FittedText text={m.rate_label} x={left+16} y={y-30} maxWidth={300} fontSize={28} maxLines={1} anchor="start" fill={MUTED}/>:null}{m.time_label?<FittedText text={m.time_label} x={Math.min(right-10,x+25)} y={y-30} maxWidth={260} fontSize={30} maxLines={1} anchor={x>1450?"end":"start"} fill={color(i)}/>:null}</g>})}<line x1={left} y1={axisY} x2={right} y2={axisY} stroke={PAPER} strokeWidth={5}/><FittedText text={`0 ${axis.unit}`} x={left} y={axisY+62} maxWidth={180} fontSize={30} maxLines={1}/><FittedText text={`${axis.max} ${axis.unit}`} x={right} y={axisY+62} maxWidth={220} fontSize={30} maxLines={1}/><FittedText text={axis.label} x={(left+right)/2} y={axisY+62} maxWidth={460} fontSize={30} maxLines={1} fill={MUTED}/>{scene.equation?<FittedText text={scene.equation} x={W/2} y={Math.min(SAFE_BOTTOM-10,axisY+145)} maxWidth={SAFE_W} fontSize={62} maxLines={1} fill={ACCENT}/>:null}</Frame>;
}

function Timeline({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), nodes=(scene.nodes??[]).slice(0,7), left=240,right=1680,y=590,step=nodes.length>1?(right-left)/(nodes.length-1):0;
  return <Frame blueprint="timeline"><Caption scene={scene}/><line x1={left} y1={y} x2={right} y2={y} stroke="#29415E" strokeWidth={8}/>{nodes.map((n,i)=>{const x=left+i*step,t=entrance(r,n.retained,i,nodes.length);return <g key={n.id} opacity={.25+.75*t} data-entity-id={n.id}><circle cx={x} cy={y} r={27} fill={color(i)}/><FittedText text={n.label} x={x} y={y-85} maxWidth={Math.min(280,step||280)} fontSize={36} maxLines={2}/>{n.sub_label?<FittedText text={n.sub_label} x={x} y={y+78} maxWidth={Math.min(260,step||260)} fontSize={27} maxLines={2} fill={MUTED}/>:null}</g>})}</Frame>;
}

function Process({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), steps=(scene.steps??[]).slice(0,7), cols=Math.min(4,steps.length), cardW=310,cardH=155,gapX=55,gapY=75,total=cols*cardW+(cols-1)*gapX,startX=(W-total)/2+cardW/2,startY=380;
  const pos=steps.map((_,i)=>({x:startX+(i%cols)*(cardW+gapX),y:startY+Math.floor(i/cols)*(cardH+gapY)}));
  return <Frame blueprint="process"><Caption scene={scene}/>{pos.slice(1).map((p,i)=><Arrow key={`a${i}`} x1={pos[i]!.x+cardW/2-8} y1={pos[i]!.y} x2={p.x-cardW/2+8} y2={p.y} opacity={entrance(r,false,i,steps.length)}/>) }{steps.map((n,i)=><NodeBox key={n.id} node={n} x={pos[i]!.x} y={pos[i]!.y} w={cardW} h={cardH} index={i} opacity={.25+.75*entrance(r,n.retained,i,steps.length)}/>)}</Frame>;
}

function Sequence({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), nodes=(scene.nodes??[]).slice(0,6), top=320,gap=Math.min(120,560/Math.max(1,nodes.length-1));
  return <Frame blueprint="sequence"><Caption scene={scene}/>{nodes.map((n,i)=>{const y=top+i*gap,t=entrance(r,n.retained,i,nodes.length);return <g key={n.id} opacity={.25+.75*t}><circle cx={410} cy={y} r={32} fill={color(i)}/><FittedText text={String(i+1)} x={410} y={y+10} maxWidth={45} fontSize={32} maxLines={1} fill={BG}/><FittedText text={n.label} x={490} y={y+12} maxWidth={1100} fontSize={42} maxLines={1} anchor="start"/>{i<nodes.length-1?<line x1={410} y1={y+36} x2={410} y2={y+gap-36} stroke="#395575" strokeWidth={6}/>:null}</g>})}</Frame>;
}

function CauseChain({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), nodes=(scene.nodes??[]).slice(0,6), edges=scene.edges??[], left=270,right=1650,y=600,step=nodes.length>1?(right-left)/(nodes.length-1):0, positions=new Map(nodes.map((n,i)=>[n.id,{x:left+i*step,y}]));
  return <Frame blueprint="cause_chain"><Caption scene={scene}/>{edges.map((e,i)=>{const a=positions.get(e.from),b=positions.get(e.to);return a&&b?<Arrow key={`${e.from}-${e.to}`} x1={a.x+120} y1={a.y} x2={b.x-120} y2={b.y} label={e.label} opacity={entrance(r,e.retained,i,edges.length)}/>:null})}{nodes.map((n,i)=>{const p=positions.get(n.id)!;return <NodeBox key={n.id} node={n} x={p.x} y={p.y} w={230} h={165} index={i} opacity={.25+.75*entrance(r,n.retained,i,nodes.length)}/>})}</Frame>;
}

function Branching({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), nodes=(scene.nodes??[]).slice(0,7), edges=scene.edges??[]; const outgoing=new Map<string,Rfc0010Edge[]>(); edges.forEach(e=>outgoing.set(e.from,[...(outgoing.get(e.from)??[]),e])); const sourceId=[...outgoing.entries()].sort((a,b)=>b[1].length-a[1].length)[0]?.[0]??nodes[0]?.id; const source=nodes.find(n=>n.id===sourceId)??nodes[0]; const outcomes=nodes.filter(n=>n.id!==source?.id); const sx=570,sy=600, ox=1370, spread=Math.min(260,560/Math.max(1,outcomes.length-1)); const positions=new Map<string,{x:number;y:number}>(); if(source) positions.set(source.id,{x:sx,y:sy}); outcomes.forEach((n,i)=>positions.set(n.id,{x:ox,y:sy-(outcomes.length-1)*spread/2+i*spread}));
  return <Frame blueprint="branching"><Caption scene={scene}/>{edges.map((e,i)=>{const a=positions.get(e.from),b=positions.get(e.to);return a&&b?<Arrow key={`${e.from}-${e.to}`} x1={a.x+160} y1={a.y} x2={b.x-160} y2={b.y} label={e.label} opacity={entrance(r,e.retained,i,edges.length)}/>:null})}{source?<NodeBox node={source} x={sx} y={sy} w={320} h={180} index={0}/>:null}{outcomes.map((n,i)=>{const p=positions.get(n.id)!;return <NodeBox key={n.id} node={n} x={p.x} y={p.y} w={320} h={155} index={i+1} opacity={.25+.75*entrance(r,n.retained,i,outcomes.length)}/>})}</Frame>;
}

function Comparison({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), nodes=(scene.nodes??[]).slice(0,3), cardW=480, gap=70,total=nodes.length*cardW+(nodes.length-1)*gap,start=(W-total)/2+cardW/2;
  return <Frame blueprint="comparison"><Caption scene={scene}/>{nodes.map((n,i)=><g key={n.id}><NodeBox node={n} x={start+i*(cardW+gap)} y={590} w={cardW} h={360} index={i} opacity={.25+.75*entrance(r,n.retained,i,nodes.length)}/><FittedText text={i===0?"A":i===1?"B":"C"} x={start+i*(cardW+gap)} y={365} maxWidth={80} fontSize={34} maxLines={1} fill={color(i)}/></g>)}</Frame>;
}

function BeforeAfter({scene}:{scene:Rfc0010Scene}) {
  const r=progress(),t=entrance(r,false,0,1); return <Frame blueprint="before_after"><Caption scene={scene}/>{scene.before?<NodeBox node={scene.before} x={560} y={590} w={650} h={360} index={0}/>:null}<Arrow x1={905} y1={590} x2={1015} y2={590} opacity={t}/>{scene.after?<NodeBox node={scene.after} x={1360} y={590} w={650} h={360} index={1} opacity={.25+.75*t}/>:null}<FittedText text="BEFORE" x={560} y={350} maxWidth={300} fontSize={32} maxLines={1} fill={MUTED}/><FittedText text="AFTER" x={1360} y={350} maxWidth={300} fontSize={32} maxLines={1} fill={GREEN}/></Frame>;
}

function RelationshipGraph({scene}:{scene:Rfc0010Scene}) {
  const r=progress(), nodes=(scene.nodes??[]).slice(0,7), edges=scene.edges??[], cx=W/2,cy=600,rx=620,ry=280,positions=new Map<string,{x:number;y:number}>(); nodes.forEach((n,i)=>{const a=-Math.PI/2+i*(Math.PI*2/nodes.length);positions.set(n.id,{x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry});});
  return <Frame blueprint="relationship_graph"><Caption scene={scene}/>{edges.map((e,i)=>{const a=positions.get(e.from),b=positions.get(e.to);return a&&b?<Arrow key={`${e.from}-${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} label={e.label} opacity={entrance(r,e.retained,i,edges.length)}/>:null})}{nodes.map((n,i)=>{const p=positions.get(n.id)!;return <NodeBox key={n.id} node={n} x={p.x} y={p.y} w={260} h={130} index={i} opacity={.25+.75*entrance(r,n.retained,i,nodes.length)}/>})}</Frame>;
}

function Quantity({scene}:{scene:Rfc0010Scene}) {
  const r=progress(),items=(scene.items??[]).slice(0,5),max=Math.max(...items.map(i=>Math.abs(i.value)),1),first=325,gap=Math.min(135,560/Math.max(1,items.length)),left=620,maxW=850;
  return <Frame blueprint="quantity"><Caption scene={scene}/>{items.map((it,i)=>{const y=first+i*gap,t=entrance(r,it.retained,i,items.length),w=maxW*Math.abs(it.value)/max*t;return <g key={it.id}><FittedText text={it.label} x={left-45} y={y+12} maxWidth={390} fontSize={38} maxLines={2} anchor="end" fill={color(i)}/><rect x={left} y={y-32} width={Math.max(6,w)} height={64} rx={14} fill={color(i)}/><FittedText text={it.rate_label??it.time_label??String(it.value)} x={left+Math.max(6,w)+25} y={y+14} maxWidth={250} fontSize={34} maxLines={1} anchor="start"/></g>})}</Frame>;
}

function KineticPhrase({scene}:{scene:Rfc0010Scene}) {
  const r=progress(),lines=(scene.lines??[]).slice(0,3); return <Frame blueprint="kinetic_phrase">{lines.map((l,i)=><FittedText key={i} text={l.text} x={W/2} y={430+i*135} maxWidth={SAFE_W} fontSize={l.emphasis?116:58} maxLines={2} fill={l.emphasis?ACCENT:PAPER} weight={l.emphasis?930:800} opacity={entrance(r,false,i,lines.length)}/>)}</Frame>;
}

export function Rfc0010SceneRenderer({scene}:{scene:Rfc0010Scene}) {
  switch(scene.kind){
    case "scale_comparison": return scene.axis?<ScaleComparison scene={scene}/>:<KineticPhrase scene={scene}/>;
    case "timeline": return <Timeline scene={scene}/>;
    case "process": return <Process scene={scene}/>;
    case "cause_chain": return <CauseChain scene={scene}/>;
    case "branching": return <Branching scene={scene}/>;
    case "comparison": return <Comparison scene={scene}/>;
    case "before_after": return <BeforeAfter scene={scene}/>;
    case "relationship_graph": return <RelationshipGraph scene={scene}/>;
    case "sequence": return <Sequence scene={scene}/>;
    case "quantity": return <Quantity scene={scene}/>;
    case "kinetic_phrase": default: return <KineticPhrase scene={scene}/>;
  }
}
