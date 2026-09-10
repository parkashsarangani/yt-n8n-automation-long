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
  assert.match(ass,/0:00:02.00,0:00:05.00,Label/);
  assert.match(ass,/TRY THIS/);
  assert.doesNotMatch(ass,/\{\\pos\(0,0\)\}/);
  assert.throws(()=>buildStage([{}],[0]),/measured/);
});
