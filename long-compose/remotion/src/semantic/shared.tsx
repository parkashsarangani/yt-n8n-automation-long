import {useCurrentFrame,useVideoConfig} from "remotion";import type {SemanticActionWindow,SemanticSceneProps} from "./types";
export const BG="#08101E",PAPER="#F7F4EA",ACCENT="#FFD166",GREEN="#7DE2A8",BLUE="#65C7F7",TEAL="#56D6C9",RED="#FF7D7D";
export function ratio(){const f=useCurrentFrame(),{durationInFrames}=useVideoConfig();return Math.max(0,Math.min(1,f/Math.max(1,durationInFrames-1)))}
// `names` is a hand-picked vocabulary per call site (e.g. ["drop","enter"]),
// but the planner authors free-form verbs per topic ("scatter", "compare",
// "rotate", "exit"...) with no constraint to match any renderer's list. A
// real render (run_bd3de54c, a carbonation episode) showed EVERY
// quantitative/scale-comparison scene rendering fully static -- zero pixel
// difference between sampled frames -- because none of its authored verbs
// ("cool", "warm", "compare", "expand", "move", "rise") happened to be in
// that scene's ["expand","compare","rearrange"] list, so `p` stayed 0 for
// the whole scene regardless of the narration. Expanding these lists
// forever is a losing game against an LLM's vocabulary, so this stays a
// plain verb-match lookup and actionSlot below is the fallback layer.
function matchedProgress(r:number,a:SemanticActionWindow[]|undefined,names:string[]):{value:number;matched:boolean}{
  const windows=(a||[]).filter((w)=>names.includes(w.action));
  if(!windows.length)return {value:0,matched:false};
  // When the SAME verb is authored twice for this slot (a real render did
  // this: "compare" on both a .07-.36 window and a later .55-.96 window),
  // taking Math.max across every matching window's own progress means the
  // FIRST one to saturate to 1 masks the second one's progress for the rest
  // of the scene -- once window0 hits 1 at ratio .36, max(1, window2's
  // still-rising 0..1) stays pinned at 1 all the way to .96, which is
  // exactly a static-looking scene for its second half even though a real
  // verb genuinely matched twice. Pick the CURRENTLY ACTIVE window instead
  // (the one with the latest startRatio that r has already reached), so a
  // later beat's own rising progress is what's shown once it begins,
  // instead of an earlier beat's frozen 1 hiding it.
  const active=windows.filter((w)=>r>=w.startRatio).sort((x,y)=>y.startRatio-x.startRatio)[0]||windows[0]!;
  const width=Math.max(.001,active.endRatio-active.startRatio);
  return {value:Math.max(0,Math.min(1,(r-active.startRatio)/width)),matched:true};
}
export function actionProgress(r:number,a:SemanticActionWindow[]|undefined,names:string[]){return matchedProgress(r,a,names).value}

// A first version of this fell back per-slot to a SPECIFIC other window when
// unmatched, which looked right in isolation but broke on a real render:
// run_bd3de54c's scene1-container-object authored "enter" (matching `drop`'s
// own list for real) and "scatter" (matching nothing), so `drop` animated
// correctly through its own window -- which ends at ratio .52 -- while
// `rise`/`sink` stayed at a flat 0 the entire scene, because a group-level
// "rescue only if EVERY slot is zero" check never fired (drop was already
// nonzero). The object moved once, then held perfectly still for the back
// half of the scene: motion QA's frame-difference check correctly caught
// that (differences=[0.04,0.0] between the 55%/85% samples).
//
// The fix: an UNMATCHED slot doesn't borrow one specific other window
// (which finishes early just as easily as the matched one did) -- it ramps
// smoothly across the FULL span the plan actually authored, from the
// earliest window's start to the latest window's end. That keeps the slot
// evolving for as long as the scene has ANY authored motion left to show,
// however many other slots matched for real or share this same fallback.
// A MATCHED slot is untouched here -- its own tuned, verb-specific motion
// is exactly what it was before this existed.
// `skew` (default 1 = linear, unchanged) exists for the case a real render
// exposed: ContainerObjectScene's `rise` and `sink` push the object in
// OPPOSITE directions (-130*rise, +135*sink) with near-equal magnitude. Two
// unmatched slots that share this same fallback span -- rise and sink both
// ramping 0->1 together, since neither verb was authored -- nearly cancel
// each other in that formula (net coefficient +5 of ~130), so the object
// looked almost perfectly still even though two numbers were changing under
// the hood: a scene passed its "did anything move" check within the window
// itself but still failed the frame-difference check in the window's back
// half, where drop had already saturated and rise/sink's near-cancellation
// was the only remaining motion. Passing a different skew for one sibling
// in an opposing pair (e.g. sink=1.8) keeps both smooth and monotonic but
// desynchronizes their curves enough that the pair's net effect is
// genuinely visible instead of cancelling out.
export function actionSlot(r:number,a:SemanticActionWindow[]|undefined,names:string[],skew=1):number{
  const {value,matched}=matchedProgress(r,a,names);
  if(matched)return value;
  const windows=a||[];
  if(!windows.length)return 0;
  const start=Math.min(...windows.map((w)=>w.startRatio)),end=Math.max(...windows.map((w)=>w.endRatio));
  const width=Math.max(.001,end-start);
  const linear=Math.max(0,Math.min(1,(r-start)/width));
  return skew===1?linear:Math.pow(linear,skew);
}
export function sceneClaim(x:SemanticSceneProps){return (x.visualClaim||x.keyText||x.after||x.before||x.elements?.[0]||"Main idea").trim()}
export function entityLabel(x:SemanticSceneProps,i:number,fallback:string){return x.semanticEntities?.[i]?.label||x.elements?.[i]||fallback}
export function entityColor(x:SemanticSceneProps,i:number,fallback:string){return x.semanticEntities?.[i]?.depiction.color||fallback}
export function Particle({x,y,color=ACCENT,scale=1}:{x:number;y:number;color?:string;scale?:number}){return <g transform={`translate(${x} ${y}) scale(${scale})`}><circle r="34" fill={color}/><circle cx="-37" cy="19" r="21" fill={BLUE}/><circle cx="37" cy="19" r="21" fill={BLUE}/></g>}
