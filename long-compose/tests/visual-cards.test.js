const test=require("node:test");
const assert=require("node:assert/strict");
const {cardCues,cardText}=require("../visual-cards");
test("cards reject unsupported comparisons and reveal in spoken order",()=>{
  const scene={narration:"Ask once. Leave room to decline.",visual:{kind:"comparison",title:"Two choices",items:["Ask once.","Leave room to decline."]}};
  const cues=cardCues(scene,10);
  assert.equal(cues[0].card.items.length,1);
  assert.equal(cues[1].card.items.length,2);
  assert.ok(cues[1].start>0 && cues[1].start<10);
  assert.throws(()=>cardCues({...scene,visual:{...scene.visual,items:["Ask once.","They will agree."]}},10),/absent/);
  assert.throws(()=>cardCues({...scene,visual:{...scene.visual,items:[...scene.visual.items].reverse()}},10),/order/);
});
test("long tokens wrap and steps keep their original number",()=>{
  const text=cardText({kind:"steps",title:"A".repeat(42),items:["B".repeat(72)],stepIndex:2},s=>s);
  assert.ok(text.includes("3."));
  assert.ok(!text.includes("B".repeat(37)));
});
