const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {buildStockTrack}=require('../stock-track');
const {buildStage}=require('../conversation-stage');

test('consecutive unmatched scenes share one background segment with cumulative rounding',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-track-unit-'));
  try {
    const calls=[];
    await buildStockTrack([0,1,2,3].map(scene_index=>({scene_index})),[1.01,1.01,1.01,1.01],
      [{scene_index:3,kind:'photo',file:'image.jpg'}],dir,{ffmpeg:'fixture',exec:async(_file,args)=>{calls.push(args);}});
    assert.equal(calls.length,3,'one background, one photo, one concat');
    assert.equal(calls[0][calls[0].indexOf('-frames:v')+1],'91');
    assert.equal(calls[1][calls[1].indexOf('-frames:v')+1],'30');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('stock layout consistently hides navigation but preserves legacy cards and captions',()=>{
  const scenes=[
    {point:'[scenario] Matched label',narration:'Ask once.',suppress_heading:true},
    {point:'[response] Unmatched label',narration:'Then wait.',suppress_heading:true},
    {narration:'Say hello.',suppress_heading:true,visual:{kind:'quote',title:'Greeting',items:['Say hello.']}},
  ];
  const stage=buildStage(scenes,[10,10,10]);
  assert.doesNotMatch(stage,/Matched label|Unmatched label/);
  assert.match(stage,/Dialogue:.*Heading.*Say hello/);
  assert.match(stage,/Then wait/);
});
