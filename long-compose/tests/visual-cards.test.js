const test=require("node:test");
const assert=require("node:assert/strict");
const {cardCues,cardText}=require("../visual-cards");
test("cards reveal in spoken order when items are literal narration excerpts",()=>{
  const scene={narration:"Ask once. Leave room to decline.",visual:{kind:"comparison",title:"Two choices",items:["Ask once.","Leave room to decline."]}};
  const cues=cardCues(scene,10);
  assert.equal(cues[0].card.items.length,1);
  assert.equal(cues[1].card.items.length,2);
  assert.ok(cues[1].start>0 && cues[1].start<10);
});
test("ungrounded or reversed cards never block the gradient draft render",()=>{
  const scene={narration:"Ask once. Leave room to decline.",visual:{kind:"comparison",title:"Two choices",items:["Ask once.","They will agree."]}};
  const cues=cardCues(scene,10);
  assert.equal(cues.length,2);
  assert.ok(cues.every(c=>c.start>=0 && c.start<10));

  const reversed={...scene,visual:{...scene.visual,items:["Leave room to decline.","Ask once."]}};
  const reversedCues=cardCues(reversed,10);
  assert.equal(reversedCues.length,2);
  assert.ok(reversedCues.every(c=>c.start>=0 && c.start<10));

  const malformed={narration:"A short beat.",visual:{kind:"quote",title:"t",items:["one","two"]}};
  assert.equal(cardCues(malformed,5).length,0);
});
test("long tokens wrap and steps keep their original number",()=>{
  const text=cardText({kind:"steps",title:"A".repeat(42),items:["B".repeat(72)],stepIndex:2},s=>s);
  assert.ok(text.includes("3."));
  assert.ok(!text.includes("B".repeat(37)));
});
