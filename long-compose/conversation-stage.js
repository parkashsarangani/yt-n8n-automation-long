// Text comes verbatim from the approved script, never from a second LLM.
const labels = {scenario:"THE SITUATION", response_a:"ONE RESPONSE", response_b:"ANOTHER RESPONSE", explanation:"WHY IT MATTERS", limitations:"CONTEXT MATTERS", exercise:"TRY THIS", payoff:"TAKE THIS WITH YOU"};
function safe(text) {
  return String(text).replace(/\\/g,"＼").replace(/\{/g,"（").replace(/\}/g,"）").replace(/[\r\n\x00-\x1f]/g," ");
}
function clock(seconds) {
  const n = Math.round(seconds * 100);
  return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,"0")}:${String(Math.floor(n/100)%60).padStart(2,"0")}.${String(n%100).padStart(2,"0")}`;
}
function pages(text) {
  // Bound each line and page; keep every word, splitting exceptional long tokens.
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).flatMap(w=>w.match(/.{1,32}/gu)||[]);
  const lines=[]; let line="";
  for(const word of words){if(line && line.length+word.length+1>38){lines.push(line);line="";}line+=(line?" ":"")+word;}
  if(line)lines.push(line);
  const result=[];
  for(let i=0;i<lines.length;i+=3)result.push(lines.slice(i,i+3));
  return result;
}
function buildTitleCard(text) {
  // drawtext is absent from the bundled ffmpeg build (FFmpeg 7 gates it behind
  // libharfbuzz); libass is present, so the title renders through the same
  // subtitle path the conversation stage already uses.
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).flatMap(w => w.match(/.{1,16}/gu) || []);
  const lines = []; let line = "";
  for (const word of words) { if (line && line.length + word.length + 1 > 18) { lines.push(line); line = ""; } line += (line ? " " : "") + word; }
  if (line) lines.push(line);
  const body = lines.map(safe).join("\\N");
  const style = "Style: Title,DejaVu Sans,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,60,60,40,1";
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:10.00,Title,,0,0,0,,{\\pos(640,360)}" + body,
    "",
  ].join("\n");
}

function captionCues(scene, duration) {
  const text=String(scene.narration||"").trim();
  const tokens=[...text.matchAll(/\S+/g)];
  const a=scene.audio?.alignment || scene.alignment;
  const aligned=a && Array.isArray(a.characters) && a.characters.join("").trim()===text
    && a.character_start_times_seconds?.length===a.characters.length
    && a.character_end_times_seconds?.length===a.characters.length
    && a.character_start_times_seconds.every((v,i)=>Number.isFinite(v) && v>=0 && (i===0 || v>=a.character_start_times_seconds[i-1]))
    && a.character_end_times_seconds.every((v,i)=>Number.isFinite(v) && v>=a.character_start_times_seconds[i] && v<=duration+0.15);
  const leading=aligned ? a.characters.join("").indexOf(text) : 0;
  const cues=[]; let group=[];
  const emit=()=>{
    const first=group[0], last=group[group.length-1];
    const start=aligned ? a.character_start_times_seconds[leading+first.index] : duration*first.index/Math.max(1,text.length);
    const end=aligned ? Math.min(duration,a.character_end_times_seconds[leading+last.index+last[0].length-1]) : duration*(last.index+last[0].length)/Math.max(1,text.length);
    if(end>start)cues.push({start,end,text:group.map(t=>t[0]).join(" ")});
    group=[];
  };
  for(const token of tokens) {
    if(group.length && group.map(t=>t[0]).join(" ").length+token[0].length>64)emit();
    group.push(token);
    if(group.length>=7 || /[.!?;,:]$/.test(token[0]))emit();
  }
  if(group.length)emit();
  return cues;
}
function buildStage(scenes, durations, lessonTitle) {
  let script=buildTitleCard("").replace("PlayResX: 1280","PlayResX: 1920").replace("PlayResY: 720","PlayResY: 1080");
  script=script.slice(0,script.indexOf("Dialogue:"));
  script=script.replace(/Style: Title,[^\n]+/, "Style: Caption,DejaVu Sans,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,160,160,110,1\nStyle: Heading,DejaVu Sans,32,&H007ADCE8,&H007ADCE8,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,8,160,160,65,1");
  const add=(start,end,style,text)=>{script+="Dialogue: 0,"+clock(start)+","+clock(end)+","+style+",,0,0,0,,"+text+"\n";};
  const total=durations.reduce((a,b)=>a+b,0);
  if(lessonTitle)add(0,total,"Heading",safe(String(lessonTitle).slice(0,90)));
  let offset=0;
  scenes.forEach((scene,i)=>{
    const duration=durations[i];
    if(!(duration>0))throw Error("stage requires measured scene durations");
    for(const cue of captionCues(scene,duration))add(offset+cue.start,offset+cue.end,"Caption",safe(cue.text));
    offset+=duration;
  });
  return script;
}
module.exports={buildStage,buildTitleCard,pages,captionCues};
