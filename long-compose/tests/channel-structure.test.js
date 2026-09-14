const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStage, buildTitleCard } = require('../conversation-stage');
const { channelFrame } = require('../channel-frame');
test('thumbnail motif retains branding but never covers half the image',()=>{
  const frame=channelFrame(1280,720,true);
  assert.match(frame,/w=1280:h=29/);
  assert.match(frame,/w=16:h=720/);
  assert.match(frame,/0xF3EBDD/);
  assert.match(frame,/0xE8B86A/);
  assert.doesNotMatch(frame,/w=640:h=720/);
});
test('thumbnail accent is escaped and applied in ASS BGR format',()=>{
  assert.ok(buildTitleCard('HOOK','#123456').includes('c&H563412&'));
  assert.ok(buildTitleCard('HOOK','{bad}').includes('c&HDDEBF3&'));
});
test('legacy context labels are brief and production counters are absent', () => {
  const stage = buildStage([
    {point:'[scenario] Example',narration:'Hello.'},
    {point:'[exercise] Try',narration:'Try it.'},
  ], [12.8,20.2], 'A lesson');
  assert.match(stage,/0:00:00.00,0:00:02.50,Heading.*Example/);
  assert.match(stage,/0:00:12.80,0:00:15.30,Heading.*Try/);
  assert.ok(!stage.includes("2 / 2"));
  assert.ok(!stage.includes("A lesson"));
});
test('thumbnail text stays in left negative space with literal escaping', () => {
  const card=buildTitleCard('TRY {THIS} \\ NOW');
  assert.match(card,/\\pos\(320,360\)\\fs48/);
  assert.ok(!card.includes('{THIS}'));
});
