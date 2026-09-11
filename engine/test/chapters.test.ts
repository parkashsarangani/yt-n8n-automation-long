import test from "node:test";
import assert from "node:assert/strict";
import { episodeChapters, hasChapterStart } from "../src/chapters.ts";
test("recognizes existing chapter starts without mistaking prose for chapters",()=>{
  for (const stamp of ["0:00", "00:00", "0:00:00", "00:00:00"]) {
    assert.equal(hasChapterStart(`Description\n${stamp} Introduction`),true);
  }
  for (const text of ["00 reasons to try", "Meet at 00:00 tonight", "00:001 Introduction"]) {
    assert.equal(hasChapterStart(text),false);
  }
});
test("chapters use measured clip boundaries and satisfy minimum chapter spacing",()=>{
  const scenes=["scenario","explanation","exercise","payoff"].map((r,i)=>({scene_index:i,point:`[${r}]`}));
  const clips=[12.8,20.2,30,4].map((d,i)=>({scene_index:i,duration_sec:d}));
  assert.equal(episodeChapters(scenes,clips),"00:00 The situation\n00:12 Why it matters\n00:33 Try this");
  assert.equal(episodeChapters(scenes,clips.map(c=>({...c,duration_sec:2}))),"");
});
test("chapters reject incomplete, duplicate and invalid voice timelines",()=>{
  const scenes=["scenario","explanation","exercise"].map((r,i)=>({scene_index:i,point:`[${r}]`}));
  const clips=scenes.map(s=>({scene_index:s.scene_index,duration_sec:15}));
  assert.equal(episodeChapters(scenes,clips.slice(0,2)),"");
  assert.equal(episodeChapters(scenes,[clips[0]!,clips[1]!,clips[1]!]),"");
  assert.equal(episodeChapters(scenes,clips.map(c=>({...c,duration_sec:NaN}))),"");
  assert.equal(episodeChapters(scenes,[...clips].reverse()),episodeChapters(scenes,clips));
});
