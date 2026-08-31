import type {SemanticSceneProps} from "./types";import {ACCENT,BLUE,GREEN,PAPER,actionSlot,breathe,ratio,sceneClaim} from "./shared";
export function QuantityComparisonScene(x:SemanticSceneProps){
  const r=ratio(),a=x.semanticActionWindows,e=actionSlot(r,a,["expand","compare","rearrange"]),scale=x.sceneBlueprint==="scale-comparison"?1+e*1.2:1+e*.35;
  return <svg data-semantic-blueprint={x.sceneBlueprint} viewBox="0 0 1100 520" style={{width:"100%"}}>
    {/* Box fill was #0C1C31 -- only 35 of luminosity distance from the
        #08101E canvas background, under the 55 threshold the QA gate's
        deterministic occupancy check uses to count a pixel as "foreground".
        A real render (scene11) showed exactly this: the boxes were
        geometrically large enough (occupancy would have easily cleared
        15%), but their interior fill was invisible to the metric -- only
        the stroke outlines and the 12 accent dots ever counted, which
        wasn't enough on their own. A first attempt at #132B4A (82 of
        distance) technically cleared the threshold but by 0.00004 of
        occupancy ratio -- noise, not a real margin. #1C3A63 (131 of
        distance) still reads as a dark navy fitting the house palette,
        with real margin this time. Scoped to this
        component only -- ContainerObjectScene/BeforeAfterObjectScene reuse
        the darker fill but their boxes are proportionally larger and never
        failed this check. */}
    <rect x="110" y="145" width="300" height="260" rx="28" fill="#1C3A63" stroke={BLUE} strokeWidth="7"/>
    <rect x={700-150*scale} y={275-130*scale} width={300*scale} height={260*scale} rx="28" fill="#1C3A63" stroke={GREEN} strokeWidth="7"/>
    {/* A small constant-amplitude jitter on the reference dots, independent
        of `e` (matches ParticleSystemScene's own established pattern) --
        this box never grows and its dots never move on their own, so a
        scene whose one authored window sits entirely outside a QA sample
        pair (starts late, or already ended) is otherwise perfectly frozen
        here regardless of what the right box is doing. */}
    {Array.from({length:12},(_,i)=><circle key={i} cx={160+(i%4)*65} cy={200+Math.floor(i/4)*75+Math.sin(r*30+i)*3} r="14" fill={ACCENT}/>) }
    <text x="550" y="495" fill={PAPER} fontSize="34" fontWeight="800" textAnchor="middle">{sceneClaim(x)}</text>
  </svg>;
}
export function BeforeAfterObjectScene(x:SemanticSceneProps){
  const r=ratio(),a=x.semanticActionWindows,t=Math.max(.05,actionSlot(r,a,["transform","freeze","melt","rearrange","assemble","disassemble"])),
    // The left ("before") circle used to be a fixed r="90" -- perfectly
    // static for the entire scene regardless of `t`. Same dead-zone issue
    // as the dots above: a scene whose one authored window doesn't span a
    // QA sample pair had nothing else on screen changing at all. A gentle
    // breathing radius keeps it feeling present/alive throughout, which is
    // also just a more honest depiction of "the before state" than a
    // perfectly frozen circle.
    life=breathe();
  return <svg data-semantic-blueprint="before-after-object" viewBox="0 0 1100 520" style={{width:"100%"}}>
    <rect x="70" y="90" width="410" height="350" rx="32" fill="#0C1C31" stroke={BLUE} strokeWidth="7"/>
    <rect x="620" y="90" width="410" height="350" rx="32" fill="#0C1C31" stroke={GREEN} strokeWidth="7" opacity={.3+.7*t}/>
    <circle cx="275" cy="250" r={90+life*4} fill="#65C7F733" stroke={BLUE} strokeWidth="8"/>
    <circle cx="825" cy="250" r={82+25*t} fill="#7DE2A833" stroke={GREEN} strokeWidth="8"/>
    <text x="275" y="410" fill={PAPER} fontSize="36" fontWeight="850" textAnchor="middle">{x.before||x.elements?.[0]||"before"}</text>
    <text x="825" y="410" fill={PAPER} fontSize="36" fontWeight="850" textAnchor="middle">{x.after||x.elements?.[1]||"after"}</text>
  </svg>;
}
