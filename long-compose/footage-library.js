const fs=require("node:fs/promises");
const path=require("node:path");
const {createHash}=require("node:crypto");
const words=s=>String(s||"").toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const stop=new Set(["the","and","you","your","with","that","this","for","from","one","then","them","they","what","when","into","have","will"]);
function relevant(asset,scene){
  const spoken=new Set(words(scene.narration).filter(w=>w.length>2&&!stop.has(w)));
  return new Set(asset.tags.flatMap(words).filter(w=>spoken.has(w))).size;
}
async function loadLibrary(directory){
  const root=await fs.realpath(directory);
  const raw=await fs.readFile(path.join(root,"manifest.json"),"utf8");
  if(raw.length>1024*1024)throw Error("Footage manifest exceeds 1 MB");
  const manifest=JSON.parse(raw);
  if(manifest.version!==1||!Array.isArray(manifest.assets)||manifest.assets.length>1000)
    throw Error("Invalid footage manifest");
  const ids=new Set();
  for(const a of manifest.assets){
    if(!a.id||ids.has(a.id)||!["video","photo"].includes(a.kind)||!a.file
      ||!Array.isArray(a.tags)||!a.tags.length||a.tags.some(t=>typeof t!=="string")
      ||a.reviewed!==true||!a.creator||!a.source_url||!a.license_url||!a.credit
      ||typeof a.sha256!=="string"||!/^[a-f0-9]{64}$/.test(a.sha256))
      throw Error("Footage assets require unique IDs, tags, review, source, license, credit and SHA-256");
    for(const url of [a.source_url,a.license_url])if(new URL(url).protocol!=="https:")throw Error("Footage provenance must use HTTPS");
    if(a.credit.length>500)throw Error("Footage credit exceeds 500 characters");
    if(a.start_sec!==undefined&&(!Number.isFinite(a.start_sec)||a.start_sec<0))throw Error("Invalid footage start time");
    ids.add(a.id);
    const extensions=a.kind==="video"?[".mp4",".mov",".webm"]:[".png",".jpg",".jpeg",".webp"];
    if(!extensions.includes(path.extname(a.file).toLowerCase()))throw Error("Unsupported footage file type");
  }
  return {root,assets:manifest.assets};
}
async function planFootage(scenes,durations,directory){
  if(!directory)throw Error("Hybrid footage requires FOOTAGE_LIBRARY and a reviewed manifest.json");
  const library=await loadLibrary(directory);
  const selected=[];const used=new Set();let offset=0;
  for(let i=0;i<scenes.length;i++){
    const scene=scenes[i],start=offset;offset+=durations[i];
    // A/B comparisons and exercises are clearer as graphics. Establishing
    // shots introduce quote scenes; do not cover an important response.
    if(scene.is_outro||selected.length>=4||durations[i]<3
      ||(scene.visual&&scene.visual.kind!=="quote"))continue;
    const ranked=library.assets.filter(a=>!used.has(a.id))
      .map(a=>({a,score:relevant(a,scene)})).filter(x=>x.score>=2)
      .sort((a,b)=>b.score-a.score||a.a.id.localeCompare(b.a.id));
    if(!ranked.length)continue;
    const asset=ranked[0].a;
    const file=await fs.realpath(path.resolve(library.root,asset.file));
    const relative=path.relative(library.root,file);
    if(relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))throw Error("Footage file escapes library");
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>50*1024*1024)throw Error("Footage file must be at most 50 MB");
    const digest=createHash("sha256").update(await fs.readFile(file)).digest("hex");
    if(digest!==asset.sha256)throw Error("Footage checksum changed; review the replacement asset");
    used.add(asset.id);
    selected.push({scene_index:scene.scene_index,file,kind:asset.kind,start_sec:asset.start_sec||0,
      start,duration:Math.min(5,durations[i]*0.35),
      credit:{id:asset.id,creator:asset.creator,source_url:asset.source_url,license_url:asset.license_url,credit:asset.credit,sha256:digest}});
  }
  if(!selected.length)throw Error("No relevant reviewed footage matched this episode; add scene-specific assets or explicitly select graphics mode");
  return selected;
}
module.exports={loadLibrary,planFootage};
