// Vertical Shorts/Reels draft (2026-09-29): aspect "9:16" renders 1080x1920,
// asks stock providers for portrait footage, fills the frame with it, and
// keeps captions inside the safe band -- never in the bottom fifth, where every
// app draws its own caption and buttons.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const exec=require('node:util').promisify(require('node:child_process').execFile);
const ffmpeg=require('ffmpeg-static');
const {buildAudioFirstVideo}=require('../compose');

test('a 9:16 draft is 1080x1920 with portrait stock filling the frame and captions in the safe band',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vertical-render-test-'));
  const names=['FOOTAGE_MODE','PEXELS_API_KEY','PIXABAY_API_KEY','UNSPLASH_ACCESS_KEY','STOCK_CACHE_DIR'];
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]])); const oldFetch=global.fetch;
  const orientations=[];
  try{
    const mp4=path.join(dir,'video.mp4'),wav=path.join(dir,'voice.wav');
    await exec(ffmpeg,['-y','-f','lavfi','-i','color=c=red:s=720x1280:r=30','-t','4','-c:v','libx264',mp4]);
    await exec(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4',wav]);
    const videoBytes=await fs.readFile(mp4);
    global.fetch=async raw=>{
      const u=new URL(raw);
      if(u.hostname==='videos.pexels.com')return new Response(videoBytes);
      assert.equal(u.hostname,'api.pexels.com');
      orientations.push(u.searchParams.get('orientation'));
      if(u.pathname.includes('/videos/'))return Response.json({videos:[{id:1,duration:4,user:{name:'Fixture'},url:'https://www.pexels.com/video/office-meeting-1/',
        // A landscape rendition must be ignored; only the portrait one fits a Short.
        video_files:[{file_type:'video/mp4',width:1920,height:1080,link:'https://videos.pexels.com/landscape.mp4'},
                     {file_type:'video/mp4',width:1080,height:1920,link:'https://videos.pexels.com/portrait.mp4'}]}]});
      return Response.json({photos:[]});
    };
    Object.assign(process.env,{FOOTAGE_MODE:'stock',PEXELS_API_KEY:'test',PIXABAY_API_KEY:'',UNSPLASH_ACCESS_KEY:'',STOCK_CACHE_DIR:path.join(dir,'cache')});
    const audio={audio_base64:(await fs.readFile(wav)).toString('base64'),media_type:'audio/wav'};
    const output=path.join(dir,'draft.mp4');
    const duration=await buildAudioFirstVideo([{narration:'An office meeting goes quiet.',scene_index:0,audio}],output,{aspect:'9:16'});
    assert.ok(Math.abs(duration-4)<0.1);
    assert.ok(orientations.length>0 && orientations.every(o=>o==='portrait'),`stock must be searched in portrait, got ${orientations}`);

    const probe=await exec(ffmpeg,['-i',output]).catch(e=>e);
    assert.match(String(probe.stderr),/1080x1920/,'draft is vertical 1080x1920');

    async function pixels(time,crop){
      return (await exec(ffmpeg,['-v','error','-ss',String(time),'-i',output,'-vf',`${crop},format=rgb24`,'-frames:v','1','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:8*1024*1024})).stdout;
    }
    const top=await pixels(1,'crop=2:2:540:400');
    assert.ok(top[0]>180&&top[2]<60,'portrait footage fills the frame');
    const bottomFifth=await pixels(1,'crop=900:300:40:1560');
    assert.ok(bottomFifth.every((v,i)=>i%3!==1||v<120),'no white caption glyphs in the bottom fifth');
    const band=await pixels(1,'crop=900:250:40:1240');
    assert.ok(band.filter((v,i)=>i%3===1&&v>200).length>100,'caption glyphs sit in the safe band');
    const sound=await exec(ffmpeg,['-v','error','-i',output,'-map','0:a:0','-t','0.1','-f','s16le','pipe:1'],{encoding:'buffer'});
    assert.ok(sound.stdout.some(v=>v!==0),'narration audio is preserved');
  }finally{
    global.fetch=oldFetch;
    for(const n of names)if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n];
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('an unknown aspect is refused rather than guessed',async()=>{
  await assert.rejects(()=>buildAudioFirstVideo([{scene_index:0,audio:{audio_base64:'AA==',media_type:'audio/wav'}}],'/nonexistent.mp4',{aspect:'1:1'}),/aspect must be/);
});
