const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const {createHash}=require("node:crypto");
const {planFootage}=require("../footage-library");
test("footage matches narration, checks provenance and never escapes the library",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"footage-test-"));
  try{
    const bytes=Buffer.from("fixture");
    await fs.writeFile(path.join(dir,"clip.mp4"),bytes);
    const asset={id:"one",kind:"video",file:"clip.mp4",tags:["phone","invitation"],reviewed:true,
      creator:"Test fixture",source_url:"https://example.com/source",license_url:"https://example.com/license",
      credit:"Test fixture only",sha256:createHash("sha256").update(bytes).digest("hex")};
    const write=a=>fs.writeFile(path.join(dir,"manifest.json"),JSON.stringify({version:1,assets:[a]}));
    await write(asset);
    const scenes=[{scene_index:0,narration:"Your phone shows an invitation.",visual:{kind:"quote"}},{scene_index:1,narration:"Your phone shows an invitation.",visual:{kind:"quote"}}];
    const shots=await planFootage(scenes,[12,12],dir);
    assert.equal(shots.length,1);
    assert.ok(Math.abs(shots[0].duration-4.2)<0.001);
    await assert.rejects(()=>planFootage([{scene_index:0,narration:"A mountain trail."}],[10],dir),/No relevant/);
    await write({...asset,reviewed:false});
    await assert.rejects(()=>planFootage(scenes,[12,12],dir),/review/);
    await write({...asset,sha256:"0".repeat(64)});
    await assert.rejects(()=>planFootage(scenes,[12,12],dir),/checksum/);
    const outside=path.join(path.dirname(dir),"outside-"+path.basename(dir)+".mp4");
    await fs.writeFile(outside,bytes);
    await write({...asset,file:outside});
    try {
    await assert.rejects(()=>planFootage(scenes,[12,12],dir),/escapes/);
    } finally {await fs.unlink(outside);}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
