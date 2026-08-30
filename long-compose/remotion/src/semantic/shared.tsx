import {useCurrentFrame,useVideoConfig} from "remotion";import type {SemanticActionWindow,SemanticSceneProps} from "./types";
export const BG="#08101E",PAPER="#F7F4EA",ACCENT="#FFD166",GREEN="#7DE2A8",BLUE="#65C7F7",TEAL="#56D6C9",RED="#FF7D7D";
export function ratio(){const f=useCurrentFrame(),{durationInFrames}=useVideoConfig();return Math.max(0,Math.min(1,f/Math.max(1,durationInFrames-1)))}
export function actionProgress(r:number,a:SemanticActionWindow[]|undefined,names:string[]){let p=0;for(const w of a||[])if(names.includes(w.action)){const width=Math.max(.001,w.endRatio-w.startRatio);p=Math.max(p,Math.max(0,Math.min(1,(r-w.startRatio)/width)))}return p}
export function sceneClaim(x:SemanticSceneProps){return (x.visualClaim||x.keyText||x.after||x.before||x.elements?.[0]||"Main idea").trim()}
export function entityLabel(x:SemanticSceneProps,i:number,fallback:string){return x.semanticEntities?.[i]?.label||x.elements?.[i]||fallback}
export function entityColor(x:SemanticSceneProps,i:number,fallback:string){return x.semanticEntities?.[i]?.depiction.color||fallback}
export function Particle({x,y,color=ACCENT,scale=1}:{x:number;y:number;color?:string;scale?:number}){return <g transform={`translate(${x} ${y}) scale(${scale})`}><circle r="34" fill={color}/><circle cx="-37" cy="19" r="21" fill={BLUE}/><circle cx="37" cy="19" r="21" fill={BLUE}/></g>}
