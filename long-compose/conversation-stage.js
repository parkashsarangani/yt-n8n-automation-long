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
function buildStage(scenes, durations) {
  let script=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Card,DejaVu Sans,54,&H00F4F1E9,&H00F4F1E9,&H001F2532,&H001F2532,0,0,0,0,100,100,0,0,1,0,0,5,240,240,80,1\nStyle: Label,DejaVu Sans,26,&H00CEC57A,&H00CEC57A,&H00101217,&H00101217,-1,0,0,0,100,100,2,0,1,0,0,5,120,120,80,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const add=(start,end,style,text)=>{script+=`Dialogue: 0,${clock(start)},${clock(end)},${style},,0,0,0,,${text}\n`;};
  let offset=0;
  scenes.forEach((scene,i)=>{
    const duration=durations[i];
    if(!(duration>0))throw Error("stage requires measured scene durations");
    const role=/^\[([^\]]+)\]/.exec(scene.point||"")?.[1];
    const label=scene.is_outro?"CONTINUE THE CONVERSATION":labels[role]||"LISTEN & REFLECT";
    add(offset,offset+duration,"Label",`{\\pos(960,230)}${label}`);
    add(offset,offset+duration,"Label",`{\\pos(960,875)}${String(i+1).padStart(2,"0")} / ${String(scenes.length).padStart(2,"0")}`);
    const chunks=pages(scene.narration);
    const weights=chunks.map(p=>p.join(" ").length);const total=weights.reduce((a,b)=>a+b,0);
    let elapsed=0;
    chunks.forEach((page,j)=>{
      const end=elapsed+duration*weights[j]/total;
      // Scene clocks are measured. Page timing is proportional, not word alignment.
      add(offset+elapsed,offset+end,"Card",`{\\pos(960,530)\\fad(100,100)}${page.map(safe).join("\\N")}`);
      elapsed=end;
    });
    offset+=duration;
  });
  return script;
}
module.exports={buildStage,buildTitleCard,pages};
