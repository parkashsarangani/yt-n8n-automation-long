import type {SemanticSceneProps} from "./types";import {ACCENT,BLUE,GREEN,PAPER,actionSlot,breathe,entityColor,entityLabel,ratio,sceneClaim} from "./shared";
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
    life=breathe(),
    // This component used to draw two identical solid circles with only a
    // text label distinguishing them -- a real render (the soda-can
    // episode, "the opened cold soda loses visible fizz within a ten-minute
    // interval") showed exactly why that's not a depiction: two colored
    // dots don't show a can *losing fizz*, they show two colored dots. Real
    // per-entity color/label now come from semanticEntities (like
    // ContainerObjectScene already does), and a cluster of particles
    // visibly thins out and escapes upward from the "after" object as `t`
    // advances -- a generic-enough dissolve/depart motion to stand for "a
    // property is leaving/diminishing" across topics (gas escaping, heat
    // loss, melting, decay), not just this one soda scene.
    beforeColor=entityColor(x,0,BLUE),afterColor=entityColor(x,1,GREEN),
    particleCount=8,survivors=Math.max(0,Math.round(particleCount*(1-t))),escaped=particleCount-survivors;
  return <svg data-semantic-blueprint="before-after-object" viewBox="0 0 1100 520" style={{width:"100%"}}>
    <rect x="70" y="90" width="410" height="350" rx="32" fill="#0C1C31" stroke={beforeColor} strokeWidth="7"/>
    <rect x="620" y="90" width="410" height="350" rx="32" fill="#0C1C31" stroke={afterColor} strokeWidth="7" opacity={.3+.7*t}/>
    <circle cx="275" cy="250" r={90+life*4} fill={`${beforeColor}33`} stroke={beforeColor} strokeWidth="8"/>
    <circle cx="825" cy="250" r={82+25*t} fill={`${afterColor}33`} stroke={afterColor} strokeWidth="8"/>
    {Array.from({length:particleCount},(_,i)=>{
      const angle=(i/particleCount)*Math.PI*2+life*.4,rad=48+Math.sin(life*20+i)*6;
      return <circle key={`b${i}`} cx={275+Math.cos(angle)*rad} cy={250+Math.sin(angle)*rad} r="7" fill={beforeColor}/>;
    })}
    {Array.from({length:survivors},(_,i)=>{
      const angle=(i/particleCount)*Math.PI*2+life*.4,rad=40+Math.sin(life*20+i)*6;
      return <circle key={`s${i}`} cx={825+Math.cos(angle)*rad} cy={250+Math.sin(angle)*rad} r="7" fill={afterColor}/>;
    })}
    {Array.from({length:escaped},(_,i)=>{
      // Particles that already left the survivor cluster rise out of the
      // box and fade -- the visible act of the attribute departing, not
      // just a shrinking circle.
      const escapeT=Math.min(1,t*1.6),y=250-100*escapeT-i*16;
      return <circle key={`e${i}`} cx={800+i*10} cy={y} r="6" fill={afterColor} opacity={Math.max(0,.85-escapeT)}/>;
    })}
    <path d="M500 250 L600 250 M578 232 L602 250 L578 268" fill="none" stroke={ACCENT} strokeWidth="8" opacity={.4+.6*t}/>
    <text x="275" y="410" fill={PAPER} fontSize="36" fontWeight="850" textAnchor="middle">{x.before||entityLabel(x,0,"before")}</text>
    <text x="825" y="410" fill={PAPER} fontSize="36" fontWeight="850" textAnchor="middle">{x.after||entityLabel(x,1,"after")}</text>
  </svg>;
}
