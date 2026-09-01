import type {SemanticSceneProps} from "./types";import {ACCENT,BLUE,GREEN,PAPER,TEAL,actionSlot,entityColor,entityLabel,ratio,sceneClaim} from "./shared";
// Real production data (run_bd3de54c, scenes 5 and 16 of the soda-can
// episode) showed this component's whole visible surface was hardcoded
// color -- #163A5C vessel, #DDF6FF top strip, #65C7F766/#7DE2A84A ellipses
// -- with zero text distinguishing any of it. Scene 5's actual claim was "a
// can contains carbonated soda below a gas-filled headspace above the
// liquid" (semanticEntities: soda-can #8AA6B8, carbonated soda #80503C,
// headspace #B8D5E0), but the old geometry -- a thin fill strip anchored to
// the TOP that only ever grows 42px down -- couldn't even show "liquid
// below, gas above" regardless of colour. The fill now grows from the
// vessel's floor upward (an honest "liquid filling a container" motion),
// the remaining space above it reads as the second layer, and both use the
// scene's real entity colours instead of a fixed palette -- same class of
// fix as ComparisonScenes.tsx's BeforeAfterObjectScene ("doesn't visualize
// gas leaving"), same pattern as ContainerObjectScene's entityColor/
// entityLabel use.
export function CrossSectionScene(x:SemanticSceneProps){
  const r=ratio(),a=x.semanticActionWindows,
    flow=actionSlot(r,a,["flow","move"]),
    fillLevel=actionSlot(r,a,["fill","freeze","transform"]),
    vesselColor=entityColor(x,0,BLUE),
    lowerColor=entityColor(x,1,"#65C7F7"),
    upperColor=entityColor(x,2,"#DDF6FF"),
    accentColor=entityColor(x,3,GREEN),
    floor=460,ceiling=145,
    fillHeight=36+(floor-ceiling-36)*fillLevel,
    fillTop=floor-fillHeight;
  return <svg data-semantic-blueprint="cross-section" viewBox="0 0 1100 520" style={{width:"100%"}}>
    <path d="M80 145 Q250 90 420 135 T760 130 T1020 120 L1020 460 L80 460 Z" fill="#163A5C" stroke={vesselColor} strokeWidth="7"/>
    <rect x="86" y={fillTop} width="928" height={fillHeight} fill={`${lowerColor}CC`}/>
    <rect x="86" y="151" width="928" height={Math.max(0,fillTop-151)} fill={`${upperColor}4A`}/>
    <text x="150" y={Math.min(floor-16,fillTop+40)} fill={PAPER} fontSize="26" fontWeight="800">{entityLabel(x,1,"")}</text>
    <text x="150" y="185" fill={PAPER} fontSize="26" fontWeight="800">{entityLabel(x,2,"")}</text>
    <ellipse cx={350+flow*150} cy={Math.max(190,fillTop-40)} rx="34" ry="20" fill={accentColor}/>
    <text x={350+flow*150} y={Math.max(190,fillTop-40)+42} fill={PAPER} fontSize="22" fontWeight="800" textAnchor="middle">{entityLabel(x,3,"")}</text>
    <text x="550" y="505" fill={PAPER} fontSize="34" fontWeight="800" textAnchor="middle">{sceneClaim(x)}</text>
  </svg>;
}
// No production episode has authored a "map" scene yet (unlike
// cross-section above, this fix has no real render to audit against), so
// this follows the same entityColor/entityLabel contract every sibling
// component already uses rather than a captured example: the start/end
// markers previously carried a fixed GREEN/ACCENT regardless of what the
// plan's entities actually were, and neither one was ever labeled -- two
// anonymous dots on a route.
export function MapScene(x:SemanticSceneProps){
  const r=ratio(),a=x.semanticActionWindows,reveal=actionSlot(r,a,["reveal","highlight","move"]),
    startColor=entityColor(x,0,GREEN),endColor=entityColor(x,1,ACCENT);
  return <svg data-semantic-blueprint="map" viewBox="0 0 1100 520" style={{width:"100%"}}>
    <path d="M120 130 L300 80 430 155 600 95 790 170 980 110 930 410 710 445 530 385 330 440 135 350 Z" fill="#14334B" stroke={TEAL} strokeWidth="8"/>
    <path d="M250 330 Q450 150 820 270" fill="none" stroke={ACCENT} strokeWidth="12" strokeDasharray="28 18" strokeDashoffset={-reveal*220}/>
    <circle cx="250" cy="330" r="22" fill={startColor}/>
    <text x="250" y="290" fill={PAPER} fontSize="24" fontWeight="800" textAnchor="middle">{entityLabel(x,0,"")}</text>
    <circle cx="820" cy="270" r={18+10*reveal} fill={endColor}/>
    <text x="820" y="228" fill={PAPER} fontSize="24" fontWeight="800" textAnchor="middle">{entityLabel(x,1,"")}</text>
    <text x="550" y="500" fill={PAPER} fontSize="34" fontWeight="800" textAnchor="middle">{sceneClaim(x)}</text>
  </svg>;
}
export function TimelineScene(x:SemanticSceneProps){const r=ratio(),a=x.semanticActionWindows,p=actionSlot(r,a,["reveal","move","transform"]);return <svg data-semantic-blueprint="timeline" viewBox="0 0 1100 520" style={{width:"100%"}}><line x1="120" y1="270" x2="980" y2="270" stroke={BLUE} strokeWidth="12"/>{[0,1,2,3].map(i=>{const on=Math.max(.15,Math.min(1,p*4-i));return <g key={i} opacity={on}><circle cx={170+i*250} cy="270" r="34" fill={i===3?GREEN:ACCENT}/><text x={170+i*250} y="355" fill={PAPER} fontSize="28" fontWeight="800" textAnchor="middle">{x.elements?.[i]||`stage ${i+1}`}</text></g>})}<text x="550" y="490" fill={PAPER} fontSize="34" fontWeight="800" textAnchor="middle">{sceneClaim(x)}</text></svg>}
