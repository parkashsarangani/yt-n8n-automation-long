const test=require("node:test");
const assert=require("node:assert/strict");
const {pages,buildStage}=require("../conversation-stage");
test("bounded cards retain all normal words instead of truncating narration",()=>{
  const text="A thoughtful response gives both people room to speak. ".repeat(20).trim();
  const result=pages(text);
  assert.equal(result.flat().join(" "),text);
  assert.ok(result.every(p=>p.length<=3 && p.every(l=>l.length<=38)));
});
test("stage advances at measured scene boundaries and sanitizes ASS commands",()=>{
  const ass=buildStage([{point:"[scenario]",narration:"Imagine this."},{point:"[exercise]",narration:"{\\pos(0,0)} Try this."}],[2,3]);
  assert.match(ass,/0:00:02.00,0:00:05.00,Caption/);
  assert.doesNotMatch(ass,/Style: Card|Style: Label|LISTEN & REFLECT/);
  assert.doesNotMatch(ass,/\{\\pos\(0,0\)\}/);
  assert.throws(()=>buildStage([{}],[0]),/measured/);
});

test("short captions retain words and follow real character timestamps",()=>{
  const {captionCues}=require("../conversation-stage");
  const text="Listen first. Then respond.";
  const a={characters:[...text], character_start_times_seconds:[...text].map((_,i)=>1+i*0.1), character_end_times_seconds:[...text].map((_,i)=>1+(i+1)*0.1)};
  const cues=captionCues({narration:text,audio:{alignment:a}},5);
  assert.equal(cues.map(c=>c.text).join(" "),text);
  assert.equal(cues[0].start,1);
  assert.ok(cues.every(c=>c.end<=5));
  assert.equal(captionCues({narration:text,audio:{alignment:{...a,characters:["bad"]}}},5).map(c=>c.text).join(" "),text);
});
