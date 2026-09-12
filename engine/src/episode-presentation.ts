/** Mechanical checks supplement the critic; they do not establish narrative quality. */
export function presentationErrors(payload: unknown): string[] {
  const scenes=(payload as {scenes?: Array<{point?:string;narration?:string;is_outro?:boolean;visual?:{kind:string;title:string;items:string[]}}>})?.scenes;
  if(!Array.isArray(scenes))return ["scenes required"];
  const errors:string[]=[];
  const words=(s:string)=>s.trim().split(/\s+/).filter(Boolean).length;
  const normalize=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
  for(const scene of scenes){
    if(scene.is_outro){
      if(words(scene.narration||"")>22 || /\?/.test(scene.narration||""))errors.push("outro must be at most 22 words without a second closing question");
      continue;
    }
    const v=scene.visual;
    if(!v){errors.push("substantive scene requires an approved visual card");continue;}
    const count=v.items?.length;
    if((v.kind==="quote" && count!==1)||(v.kind==="comparison" && count!==2)||(v.kind==="steps" && !(count>=2 && count<=3)))errors.push("visual card item count does not match kind");
    if(v.kind==="quote" && v.items?.some(item=>!normalize(scene.narration||"").includes(normalize(item))))errors.push("visual quote must occur in the scene narration");
  }
  const payoff=scenes.findIndex(s=>/^\[payoff\]/i.test(s.point||""));
  if(payoff>=0){
    const total=words(scenes.map(s=>s.narration||"").join(" "));
    const tail=words(scenes.slice(payoff+1).map(s=>s.narration||"").join(" "));
    if(tail>Math.min(55,total*0.15))errors.push("ending after payoff exceeds 15 percent or 55 words; compress aftermath");
  }
  return errors;
}
