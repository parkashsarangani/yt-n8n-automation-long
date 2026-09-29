// Production 2026-09-30, first real test Short: vertical captions reused
// long-form's 68-character phrases, and any phrase that could not split into
// two 22-character lines fell back to ONE shrunken line that ran off both
// edges of the 1080px frame ("...o it grabs the most dramatic explanation and
// hands it..."). This pins the real script that exposed it.
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildVerticalStage,buildSrt,captionCues,VERTICAL_LINE}=require('../conversation-stage');

const NARRATION=[
  "Wait. Before you answer that message, notice what you already decided it meant.",
  "A friend replies with three words. No emoji, no exclamation mark. And before you have even put the phone down, a whole story has written itself: they are annoyed, you said something wrong, the evening is ruined.",
  "That story arrived fast because your brain hates silence. It would rather be certain and wrong than unsure. So it grabs the most dramatic explanation and hands it to you as if it were a fact.",
  "Here is the small move that changes it. Before you reply, say the plain version to yourself: they wrote three words. That is all you actually know. Then name two other reasons someone sends three words. They were driving. They were in a queue. They were simply tired.",
  "You do not have to pick the kind explanation. You only have to notice that you picked one at all. Next time a message feels cold, pause for one breath and ask: what did they write, and what did I add?",
  "Follow for more everyday psychology.",
];
const scenes=NARRATION.map((narration,scene_index)=>({scene_index,narration}));
const durations=NARRATION.map(t=>t.split(/\s+/).length/2.6);

function dialogueLines(ass){
  return ass.split('\n').filter(l=>l.startsWith('Dialogue:')).map(l=>l.split(',,0,0,0,,')[1].replace(/\{[^}]*\}/g,'').split('\\N'));
}

test('every vertical caption fits the frame: at most two 22-character lines for real narration',()=>{
  const cues=dialogueLines(buildVerticalStage(scenes,durations));
  assert.ok(cues.length>20,'the script is captioned phrase by phrase');
  for(const lines of cues){
    assert.ok(lines.length<=2,`caption should be at most two lines: ${JSON.stringify(lines)}`);
    for(const line of lines) assert.ok(line.length<=VERTICAL_LINE,`line overflows ${VERTICAL_LINE} chars: "${line}"`);
  }
  // The exact phrase that ran off-screen in production is now split.
  assert.ok(cues.some(l=>l.join(' ').includes('the most dramatic')));
  assert.ok(!cues.some(l=>l.length===1 && l[0].includes('the most dramatic explanation and hands it')));
});

test('no caption is ever shrunk onto a single overflowing line',()=>{
  const ass=buildVerticalStage(scenes,durations);
  assert.doesNotMatch(ass,/\\fs4\d/,'the old single-line shrink (\\fs40-49) is gone');
});

test('the editor\'s captions.srt for a Short uses the same vertical phrasing; long-form SRT is unchanged',()=>{
  const vertical=buildSrt(scenes,durations,{vertical:true});
  for(const block of vertical.trim().split(/\n\n+/)){
    const text=block.split('\n').slice(2);
    for(const line of text) assert.ok(line.length<=VERTICAL_LINE,`srt line overflows: "${line}"`);
  }
  // Long-form keeps its 68-character phrasing (default unchanged).
  const longCues=captionCues(scenes[2],durations[2]);
  assert.ok(longCues.some(c=>c.text.length>36),'long-form phrases are still long-form length');
  assert.equal(buildSrt(scenes,durations),buildSrt(scenes,durations,{}));
});
