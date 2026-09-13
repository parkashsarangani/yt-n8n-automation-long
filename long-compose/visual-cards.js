// Approved script content only. No invented documents or model-generated text pixels.
function visualCard(scene) {
  const v=scene.visual;
  if(!v)return null; // Older preserved scripts remain renderable.
  const counts={quote:[1,1],comparison:[2,2],steps:[2,3]};
  const bounds=counts[v.kind];
  if(!bounds || typeof v.title!=="string" || !v.title.trim() || v.title.length>42 || !Array.isArray(v.items)
    || v.items.length<bounds[0] || v.items.length>bounds[1]
    || v.items.some(s=>typeof s!=="string" || !s.trim() || s.length>72))return null;
  return v;
}
function cardText(v,safe) {
  const wrap=s=>{
    const lines=[];let line="";
    for(const word of s.split(/\s+/).flatMap(w=>w.match(/.{1,26}/gu)||[])){if(line && line.length+word.length+1>26){lines.push(line);line="";}line+=(line?" ":"")+word;}
    if(line)lines.push(line);return lines.map(safe).join("\\N");
  };
  const entry="{\\an7\\pos(210,230)\\fad(120,0)}";
  if(v.kind==="quote")
    return entry+"{\\fs62\\c&HDDEBF3&}"+wrap(v.items[0]);
  if(v.kind==="steps")
    return entry+"{\\fs30\\c&H6AB8E8&}"+safe(v.title)+"\\N\\N{\\fs58\\c&HDDEBF3&}"
      +wrap(`${(v.stepIndex||0)+1}. ${v.items[0]}`);
  // Keep the first response visible but subdued when the alternative arrives.
  // These are excerpts, not invented messages or fake screenshots.
  return entry+v.items.map((s,i)=>
    (i===0 && v.items.length>1?"{\\fs48\\c&HAAAAAA&}":"{\\fs54\\c&HDDEBF3&}")+wrap(s)
  ).join("\\N\\N");
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
  const starts=v.items.map((item,idx)=>{
    const wanted=(item.match(/[\p{L}\p{N}]+/gu)||[]).map(w=>w.toLowerCase());
    let found=-1;
    for(let i=cursor;i<=words.length-wanted.length;i++){
      if(wanted.length && wanted.every((word,j)=>words[i+j]===word)){found=i;break;}
    }
    // Visual metadata is editor-owned and is not a render gate. If an item is
    // paraphrased or reordered, keep the episode renderable and place it at a
    // deterministic fallback point rather than failing the whole draft.
    if(found<0)return duration*(idx+1)/(v.items.length+1);
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
