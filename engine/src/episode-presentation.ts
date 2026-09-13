/** Mechanical checks supplement the critic; they do not establish narrative quality. */
export function repairVisualCards(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as any).scenes)) return payload;
  return {...payload, scenes:(payload as any).scenes.map((scene:any)=>{
    if (!scene || typeof scene.narration !== "string" || scene.is_outro) return scene;
    const v=scene.visual;
    const shaped=v && ["quote","comparison","steps"].includes(v.kind)
      && typeof v.title==="string" && v.title.length>0 && v.title.length<=42
      && Array.isArray(v.items) && v.items.every((x:unknown)=>typeof x==="string" && x.length>0 && x.length<=72)
      && Object.keys(v).every(k=>["kind","title","items"].includes(k));
    if(shaped && presentationErrors({scenes:[scene]}).length===0)return scene;
    // Exact contiguous narration excerpt. Preserve the audio/script; replace
    // only an unusable decorative card with a mechanically grounded quote.
    const tokens=[...scene.narration.matchAll(/\S+/g)];
    let end=0;
    for(const token of tokens){
      const next=token.index!+token[0].length;
      if(next>72)break;
      end=next;
      if(/[.!?]$/.test(token[0]))break;
    }
    if(!end)return scene;
    return {...scene,visual:{kind:"quote",title:"In this moment",items:[scene.narration.slice(0,end).trim()]}};
  })};
}

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
    if(v.items?.some(item=>!normalize(item) || !(" "+normalize(scene.narration||"")+" ").includes(" "+normalize(item)+" ")))errors.push("visual card items must occur in the scene narration");
    let cursor=0;
    const spoken=" "+normalize(scene.narration||"")+" ";
    for(const item of v.items||[]){
      const needle=" "+normalize(item)+" ";
      const found=spoken.indexOf(needle,cursor);
      if(found<0){errors.push("visual card items must follow narration order");break;}
      cursor=found+needle.length-1;
    }
  }
  const payoff=scenes.findIndex(s=>/^\[payoff\]/i.test(s.point||""));
  if(payoff>=0){
    const total=words(scenes.map(s=>s.narration||"").join(" "));
    const tail=words(scenes.slice(payoff+1).map(s=>s.narration||"").join(" "));
    if(tail>Math.min(55,total*0.15))errors.push("ending after payoff exceeds 15 percent or 55 words; compress aftermath");
  }
  return errors;
}
