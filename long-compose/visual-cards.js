// Approved script content only. No invented documents or model-generated text pixels.
function visualCard(scene) {
  const v=scene.visual;
  if(!v)return null; // Older preserved scripts remain renderable.
  const counts={quote:[1,1],comparison:[2,2],steps:[2,3]};
  const bounds=counts[v.kind];
  if(!bounds || typeof v.title!=="string" || !v.title.trim() || v.title.length>42 || !Array.isArray(v.items)
    || v.items.length<bounds[0] || v.items.length>bounds[1]
    || v.items.some(s=>typeof s!=="string" || !s.trim() || s.length>72))throw Error("invalid approved visual card");
  return v;
}
function cardText(v,safe) {
  const wrap=s=>{
    const lines=[];let line="";
    for(const word of s.split(/\s+/).flatMap(w=>w.match(/.{1,36}/gu)||[])){if(line && line.length+word.length+1>36){lines.push(line);line="";}line+=(line?" ":"")+word;}
    if(line)lines.push(line);return lines.map(safe).join("\\N");
  };
  return "{\\an8\\pos(960,225)\\fs40\\c&H6AB8E8&}"+wrap(v.title)+"\\N\\N{\\fs42\\c&HDDEBF3&}"
    +v.items.map((s,i)=>wrap((v.kind==="steps"?`${(v.stepIndex||0)+i+1}. `:v.kind==="comparison"?`${i===0?"A":"B"}: `:"")+s)).join("\\N\\N");
}
// Reveal approved items when their words occur, using character alignment
// where available and proportional narration timing for legacy callers.
function cardCues(scene,duration) {
  const v=visualCard(scene);
  if(!v)return [];
  const tokens=[...String(scene.narration||"").matchAll(/[\p{L}\p{N}]+/gu)];
  const words=tokens.map(t=>t[0].toLowerCase());
  const alignment=scene.audio?.alignment || scene.alignment;
  const aligned=alignment?.characters?.join("")===scene.narration
    && alignment.character_start_times_seconds?.length===alignment.characters.length
    && alignment.character_start_times_seconds.every((t,i,a)=>Number.isFinite(t)&&t>=0&&t<duration&&(i===0||t>=a[i-1]));
  let cursor=0;
  const starts=v.items.map(item=>{
    const wanted=(item.match(/[\p{L}\p{N}]+/gu)||[]).map(w=>w.toLowerCase());
    let found=-1;
    for(let i=cursor;i<=words.length-wanted.length;i++){
      if(wanted.length && wanted.every((word,j)=>words[i+j]===word)){found=i;break;}
    }
    if(found<0)throw Error("visual card item is absent or out of narration order");
    cursor=found+wanted.length;
    const position=tokens[found].index;
    return aligned?alignment.character_start_times_seconds[position]:duration*position/Math.max(1,scene.narration.length);
  });
  return starts.map((start,i)=>({
    start,end:starts[i+1]??duration,
    // Comparisons keep A visible when B arrives; steps show one action at a
    // time to avoid three long rows colliding with the caption band.
    card:{...v,stepIndex:i,items:v.kind==="steps"?[v.items[i]]:v.items.slice(0,i+1)}
  }));
}
module.exports={visualCard,cardText,cardCues};
