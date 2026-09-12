const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStage, buildTitleCard } = require('../conversation-stage');
test('scene navigation follows measured durations and is separate from captions', () => {
  const stage = buildStage([
    {point:'[scenario] Example',narration:'Hello.'},
    {point:'[exercise] Try',narration:'Try it.'},
  ], [12.8,20.2], 'A lesson');
  assert.match(stage,/0:00:00.00,0:00:12.80,Heading.*Example/);
  assert.match(stage,/0:00:12.80,0:00:33.00,Heading.*Try/);
  assert.match(stage,/\\pos\(1800,32\).*2 \/ 2/);
  assert.match(stage,/0:00:00.00,0:00:08.00,Heading.*A lesson/);
});
test('thumbnail text stays in the fixed left panel with literal escaping', () => {
  const card=buildTitleCard('TRY {THIS} \\ NOW');
  assert.match(card,/\\pos\(320,360\)\\fs48/);
  assert.ok(!card.includes('{THIS}'));
});
