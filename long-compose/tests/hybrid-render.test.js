const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const {createHash}=require("node:crypto");
const exec=require("node:util").promisify(require("node:child_process").execFile);
const ffmpeg=require("ffmpeg-static");
const {buildAudioFirstVideo}=require("../compose");
test("hybrid render shows real input pixels then returns to graphics with captions",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"hybrid-render-"));
  const oldMode=process.env.FOOTAGE_MODE,oldLibrary=process.env.FOOTAGE_LIBRARY;
  try{
    // Generated color is a reproducible test fixture, never stock footage.
    const source=path.join(dir,"source.mp4");
    await exec(ffmpeg,["-y","-f","lavfi","-i","color=c=red:s=640x360:r=30","-t","3","-c:v","libx264",source]);
    const wav=path.join(dir,"voice.wav");
    const photo=path.join(dir,"photo.png");
    await exec(ffmpeg,["-y","-f","lavfi","-i","color=c=blue:s=640x360","-frames:v","1",photo]);
    await exec(ffmpeg,["-y","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t","6",wav]);
    const asset={id:"fixture",kind:"video",file:"source.mp4",tags:["phone","invitation"],reviewed:true,
      creator:"Synthetic test fixture",source_url:"https://example.com/test",license_url:"https://example.com/test",
      credit:"Synthetic test fixture",sha256:createHash("sha256").update(await fs.readFile(source)).digest("hex")};
    const photoAsset={...asset,id:"photo",kind:"photo",file:"photo.png",tags:["coffee","table"],
      sha256:createHash("sha256").update(await fs.readFile(photo)).digest("hex")};
    await fs.writeFile(path.join(dir,"manifest.json"),JSON.stringify({version:1,assets:[asset,photoAsset]}));
    process.env.FOOTAGE_MODE="hybrid";process.env.FOOTAGE_LIBRARY=dir;
    let credits,thumbnail;
    const output=path.join(dir,"hybrid.mp4");
    const duration=await buildAudioFirstVideo([{scene_index:0,narration:"Your phone shows an invitation. Ask once.",
      visual:{kind:"quote",title:"A reply",items:["Ask once."]},audio:{audio_base64:(await fs.readFile(wav)).toString("base64"),media_type:"audio/wav"}},
      {scene_index:1,narration:"Coffee sits on the table. Leave room to decline.",visual:{kind:"quote",title:"Give it time",items:["Leave room to decline."]},
      audio:{audio_base64:(await fs.readFile(wav)).toString("base64"),media_type:"audio/wav"}}],
      output,{onFootage:(c,t)=>{credits=c;thumbnail=t;}});
    assert.ok(Math.abs(duration-12)<0.1);
    assert.equal(credits.length,2);
    assert.equal(credits[0].sha256,asset.sha256);
    assert.equal(Buffer.from(thumbnail,"base64").subarray(1,4).toString(),"PNG");
    async function pixel(time,y){
      const result=await exec(ffmpeg,["-v","error","-ss",String(time),"-i",output,"-vf",`crop=2:2:960:${y},format=rgb24`,"-frames:v","1","-f","rawvideo","pipe:1"],{encoding:"buffer"});
      return result.stdout;
    }
    const before=await pixel(1,400),after=await pixel(4,400),caption=await pixel(1,900);
    assert.ok(before[0]>180&&before[1]<50,"source footage should be visible");
    assert.ok([...after].every(v=>v<40),"graphics background should return");
    assert.ok([...caption].every(v=>v<40),"caption band stays opaque");
    const second=await pixel(7,400);
    assert.ok(second[2]>180&&second[0]<50,"photo should appear at the second scene boundary");
  }finally{
    if(oldMode===undefined)delete process.env.FOOTAGE_MODE;else process.env.FOOTAGE_MODE=oldMode;
    if(oldLibrary===undefined)delete process.env.FOOTAGE_LIBRARY;else process.env.FOOTAGE_LIBRARY=oldLibrary;
    await fs.rm(dir,{recursive:true,force:true});
  }
});
