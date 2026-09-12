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
    for(const word of s.split(/\s+/)){if(line && line.length+word.length+1>42){lines.push(line);line="";}line+=(line?" ":"")+word;}
    if(line)lines.push(line);return lines.map(safe).join("\\N");
  };
  return "{\\an8\\pos(960,225)\\fs44\\c&H6AB8E8&}"+safe(v.title)+"\\N\\N{\\fs46\\c&HDDEBF3&}"
    +v.items.map((s,i)=>wrap((v.kind==="steps"?`${i+1}. `:v.kind==="comparison"?`${i===0?"A":"B"}: `:"")+s)).join("\\N\\N");
}
module.exports={visualCard,cardText};
