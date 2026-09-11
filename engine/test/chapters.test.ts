import test from "node:test";
import assert from "node:assert/strict";
import { episodeChapters } from "../src/chapters.ts";
test("chapters use measured clip boundaries and satisfy minimum chapter spacing",()=>{
  const scenes=["scenario","explanation","exercise","payoff"].map((r,i)=>({scene_index:i,point:`[${r}]`}));
  const clips=[12.8,20.2,30,4].map((d,i)=>({scene_index:i,duration_sec:d}));
  assert.equal(episodeChapters(scenes,clips),"00:00 The situation\n00:12 Why it works\n00:33 Try it yourself");
  assert.equal(episodeChapters(scenes,clips.map(c=>({...c,duration_sec:2}))),"");
});
