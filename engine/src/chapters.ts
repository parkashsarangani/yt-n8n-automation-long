/** Build navigation from measured voice clips, never estimated script word counts. */
export function episodeChapters(scenes: Array<{scene_index: number; point?: string}>, clips: Array<{scene_index: number; duration_sec: number}>): string {
  const labels: Record<string,string> = { scenario: "The situation", response_a: "One response", response_b: "A better response", explanation: "Why it works", limitations: "When to adapt", exercise: "Try it yourself", payoff: "The takeaway" };
  const by = new Map(scenes.map(s=>[s.scene_index,s]));
  const chapters: Array<{second:number; title:string}> = [];
  let elapsed=0, previous="";
  for(const clip of [...clips].sort((a,b)=>a.scene_index-b.scene_index)) {
    if(!Number.isFinite(clip.duration_sec)||clip.duration_sec<=0)return "";
    const scene=by.get(clip.scene_index);
    if(!scene)return "";
    const role=/^\[([^\]]+)\]/.exec(scene.point||"")?.[1]||"";
    const title=labels[role];
    const second=Math.floor(elapsed);
    if(!chapters.length)chapters.push({second:0,title:title||"The situation"});
    else if(title && role!==previous && second-chapters.at(-1)!.second>=10)chapters.push({second,title});
    previous=role; elapsed+=clip.duration_sec;
  }
  while(chapters.length && elapsed-chapters.at(-1)!.second<10)chapters.pop();
  if(chapters.length<3)return "";
  return chapters.map(c=>`${String(Math.floor(c.second/60)).padStart(2,"0")}:${String(c.second%60).padStart(2,"0")} ${c.title}`).join("\n");
}
