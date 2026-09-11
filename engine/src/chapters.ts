/** Build navigation from measured voice clips, never estimated script word counts. */
export function hasChapterStart(description: string): boolean {
  return /^[\t ]*0{1,2}:00(?::00)?[\t ]+\S/m.test(description);
}

export function episodeChapters(scenes: Array<{scene_index: number; point?: string}>, clips: Array<{scene_index: number; duration_sec: number}>): string {
  const labels: Record<string,string> = { scenario: "The situation", response_a: "One response", response_b: "Another response", explanation: "Why it matters", limitations: "Context matters", exercise: "Try this", payoff: "Take this with you" };
  // A partial or duplicated timeline must never produce plausible but wrong timestamps.
  if (!scenes.length || clips.length !== scenes.length
    || new Set(scenes.map(s => s.scene_index)).size !== scenes.length
    || new Set(clips.map(c => c.scene_index)).size !== clips.length
    || scenes.some(s => !Number.isInteger(s.scene_index) || s.scene_index < 0)) return "";
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
