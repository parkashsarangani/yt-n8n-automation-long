const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const exec=require('node:util').promisify(require('node:child_process').execFile);
const ffmpeg=require('ffmpeg-static');
const {buildAudioFirstVideo}=require('../compose');

test('stock video and photo render above captions; corrupt stock falls back without losing audio timing',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-render-test-'));
  const names=['FOOTAGE_MODE','PEXELS_API_KEY','PIXABAY_API_KEY','UNSPLASH_ACCESS_KEY','STOCK_CACHE_DIR'];
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]])); const oldFetch=global.fetch;
  try{
    const mp4=path.join(dir,'video.mp4'),photo=path.join(dir,'photo.png'),wav=path.join(dir,'voice.wav');
    await exec(ffmpeg,['-y','-f','lavfi','-i','color=c=red:s=1280x720:r=30','-t','4','-c:v','libx264',mp4]);
    await exec(ffmpeg,['-y','-f','lavfi','-i','color=c=blue:s=1280x720','-frames:v','1',photo]);
    await exec(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4',wav]);
    const videoBytes=await fs.readFile(mp4),photoBytes=await fs.readFile(photo);
    global.fetch=async raw=>{
      const u=new URL(raw);
      if(u.hostname==='videos.pexels.com')return new Response(videoBytes);
      if(u.hostname==='images.pexels.com')return new Response(u.pathname==='/corrupt.jpg'?'invalid image':photoBytes);
      assert.equal(u.hostname,'api.pexels.com');
      const query=u.searchParams.get('query');
      if(u.pathname.includes('/videos/'))return Response.json({videos:query==='office meeting'?[{id:1,duration:4,user:{name:'Fixture'},url:'https://www.pexels.com/video/office-meeting-1/',
        video_files:[{file_type:'video/mp4',width:1280,height:720,link:'https://videos.pexels.com/a.mp4'}]}]:[]});
      return Response.json({photos:query==='office meeting'?[]:[{id:query==='phone message'?3:2,width:1280,height:720,photographer:'Fixture',alt:query,
        url:'https://www.pexels.com/photo/fixture/',src:{large2x:query==='phone message'?'https://images.pexels.com/corrupt.jpg':'https://images.pexels.com/photo.jpg'}}]});
    };
    Object.assign(process.env,{FOOTAGE_MODE:'stock',PEXELS_API_KEY:'test',PIXABAY_API_KEY:'',UNSPLASH_ACCESS_KEY:'',STOCK_CACHE_DIR:path.join(dir,'cache')});
    const audio={audio_base64:(await fs.readFile(wav)).toString('base64'),media_type:'audio/wav'};
    let credits,captions;
    const output=path.join(dir,'draft.mp4');
    const duration=await buildAudioFirstVideo(['An office meeting.','A coffee conversation.','A phone message.'].map((narration,scene_index)=>({narration,scene_index,audio})),output,
      {onFootage:c=>{credits=c;},onCaptions:c=>{captions=c;}});
    assert.ok(Math.abs(duration-12)<0.1);
    assert.equal(credits.length,2,'only successfully decoded footage receives credits');
    assert.match(captions,/00:00:08,000 --> 00:00:12,000/);
    async function pixels(time,crop){
      return (await exec(ffmpeg,['-v','error','-ss',String(time),'-i',output,'-vf',`${crop},format=rgb24`,'-frames:v','1','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:2*1024*1024})).stdout;
    }
    const red=await pixels(1,'crop=2:2:960:400'),blue=await pixels(5,'crop=2:2:960:400'),fallback=await pixels(9,'crop=2:2:960:400');
    assert.ok(red[0]>180&&red[2]<50);
    assert.ok(blue[2]>180&&blue[0]<50);
    assert.ok([...fallback].every(v=>v<40));
    const band=await pixels(1,'crop=2:2:50:900');
    assert.ok([...band].every(v=>v<40),'caption band stays opaque');
    const text=await pixels(1,'crop=1000:200:460:820');
    assert.ok(text.filter(v=>v>180).length>100,'caption glyphs survive the stock track');
    const sound=await exec(ffmpeg,['-v','error','-i',output,'-map','0:a:0','-t','0.1','-f','s16le','pipe:1'],{encoding:'buffer'});
    assert.ok(sound.stdout.some(v=>v!==0),'narration audio is preserved');
  }finally{
    global.fetch=oldFetch;
    for(const n of names)if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n];
    await fs.rm(dir,{recursive:true,force:true});
  }
});
