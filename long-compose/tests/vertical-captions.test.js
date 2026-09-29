// Production 2026-09-30, first real test Short: vertical captions reused
// long-form's 68-character phrases, and any phrase that could not split into
// two 22-character lines fell back to ONE shrunken line that ran off both
// edges of the 1080px frame ("...o it grabs the most dramatic explanation and
// hands it..."). This pins the real script that exposed it.
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildVerticalStage,buildSrt,captionCues,verticalLines,VERTICAL_LINE,VERTICAL_CUE,WEAK_END,LINE_HANG}=require('../conversation-stage');

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

test('vertical phrases never end on a weak word and never strand a one- or two-word tail',()=>{
  // Production 2026-09-30: "...explanation and hands / it to you as" and
  // "notice what you already decided it" followed by "meant." on its own.
  const clean=w=>w.replace(/[“”"'.,!?;:—…]/g,'');
  for(const scene of scenes){
    const cues=captionCues(scene,10,VERTICAL_CUE,true).map(c=>c.text);
    cues.forEach((text,i)=>{
      const words=text.split(' '), last=words.at(-1);
      if(!/[.!?,;:]["”']?$/.test(last)) assert.ok(!WEAK_END.test(clean(last)) && !LINE_HANG.test(clean(last)),`phrase ends on a weak word: "${text}"`);
      const startsSentence=i===0 || /[.!?]["”']?$/.test(cues[i-1].split(' ').at(-1));
      if(!startsSentence) assert.ok(words.length>2,`stranded tail caption: "${text}" after "${cues[i-1]}"`);
    });
  }
});

test('a two-line vertical caption avoids ending line one on a word that belongs to line two whenever it can',()=>{
  // Only when EVERY split that fits 22 characters hangs (e.g. "Follow for
  // more / everyday psychology.") may the chosen one hang.
  const clean=w=>w.replace(/[“”"'.,!?;:—…]/g,'');
  const hangs=w=>!/[,;:.!?—]["”']?$/.test(w) && LINE_HANG.test(clean(w));
  for(const scene of scenes) for(const cue of captionCues(scene,10,VERTICAL_CUE,true)){
    const lines=verticalLines(cue.text);
    if(lines.length!==2 || !hangs(lines[0].split(' ').at(-1)))continue;
    const words=cue.text.split(' ');
    const cleanSplitExists=words.some((_,i)=>i>0 && words.slice(0,i).join(' ').length<=VERTICAL_LINE
      && words.slice(i).join(' ').length<=VERTICAL_LINE && !hangs(words[i-1]));
    assert.ok(!cleanSplitExists,`a non-hanging split fit but was not chosen: ${JSON.stringify(lines)}`);
  }
});

test('the line split prefers a natural break over the most even one',()=>{
  // The most even split ends line one on "the" ("so it grabs the / most dramatic").
  assert.deepEqual(verticalLines('so it grabs the most dramatic'),['so it grabs','the most dramatic']);
  // A subject pronoun stays with its verb ("as if it / were a fact" was the production case).
  assert.ok(!/it$/.test(verticalLines('it to you as if it were a fact.')[0]));
});

test('long-form phrasing is untouched by the vertical tidy rules',()=>{
  // Default arguments must reproduce the original long-form cues exactly.
  for(const scene of scenes) assert.deepEqual(captionCues(scene,10),captionCues(scene,10,68,false));
});
