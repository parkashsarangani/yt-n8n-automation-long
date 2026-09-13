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
test("a card item that isn't a literal narration excerpt falls back to proportional timing instead of failing the render",()=>{
  // Visual-card correctness is no longer hard-enforced upstream (editor_review
  // is the remaining quality gate), so a paraphrased or reordered item must
  // degrade gracefully rather than crash the whole episode's render.
  const scene={narration:"Ask once. Leave room to decline.",visual:{kind:"comparison",title:"Two choices",items:["Ask once.","They will agree."]}};
  const cues=cardCues(scene,10);
  assert.equal(cues.length,2);
  assert.ok(cues.every(c=>c.start>=0 && c.start<10));

  const reversed={...scene,visual:{...scene.visual,items:[...scene.visual.items].reverse()}};
  const reversedCues=cardCues(reversed,10);
  assert.equal(reversedCues.length,2);
  assert.ok(reversedCues.every(c=>c.start>=0 && c.start<10));
});
test("a malformed visual card is treated as no card instead of failing the render",()=>{
  const {visualCard}=require("../visual-cards");
  assert.equal(visualCard({narration:"x",visual:{kind:"quote",title:"t",items:["a","b"]}}),null);
  assert.equal(visualCard({narration:"x",visual:{kind:"nonsense",title:"t",items:["a"]}}),null);
  assert.equal(cardCues({narration:"x",visual:{kind:"quote",title:"t",items:["a","b"]}},5).length,0);
});
test("long tokens wrap and steps keep their original number",()=>{
  const text=cardText({kind:"steps",title:"A".repeat(42),items:["B".repeat(72)],stepIndex:2},s=>s);
  assert.ok(text.includes("3."));
  assert.ok(!text.includes("B".repeat(37)));
});
