const test=require("node:test");
const assert=require("node:assert/strict");
const {pages,buildStage}=require("../conversation-stage");

test("long visual excerpts wrap and timeline steps appear separately",()=>{
  const ass=buildStage([{narration:"First save it. Then ask.",
    visual:{kind:"timeline",overlay:{steps:["A long approved excerpt ".repeat(8),"Then ask."]}}
  }],[10]);
  assert.match(ass,/0:00:00.00,0:00:05.00,Visual/);
  assert.match(ass,/0:00:05.00,0:00:10.00,Visual/);
  assert.match(ass,/approved.*\\N/);
  assert.doesNotMatch(ass,/Carry it forward|Pause and choose/);
});
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

test("visual cards are renderer-built and follow the scene boundary",()=>{
  const ass=buildStage([{
    point:"[response_a]",
    narration:"A colleague interrupts.",
    visual:{
      kind:"comparison",
      viewer_understands:"See the deliberate next move.",
      scene_reference:"A colleague interrupts.",
      overlay:{eyebrow:"COMPARE THE RESPONSE",left_label:"MOMENT",left_text:"Interrupted",right_label:"NEXT",right_text:"Pause first"}
    }
  }],[2]);
  assert.match(ass,/Style: Visual/);
  assert.match(ass,/COMPARE THE RESPONSE/);
  assert.match(ass,/MOMENT/);
  assert.match(ass,/0:00:00.00,0:00:02.00,Visual/);
  assert.doesNotMatch(ass,/\\pos\(0,0\)/);
});
