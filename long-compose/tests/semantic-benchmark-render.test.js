const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),zlib=require("node:zlib"),{spawnSync}=require("node:child_process"),test=require("node:test"),ffmpeg=require("ffmpeg-static");
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:"utf8",timeout:360000,...options});assert.equal(result.status,0,result.stderr||result.stdout)}
function similarity(a,b){const r=spawnSync(ffmpeg,["-hide_banner","-i",a,"-i",b,"-lavfi","ssim","-f","null","-"],{encoding:"utf8",timeout:60000}),m=(r.stderr+r.stdout).match(/All:([0-9.]+)/);assert.ok(m);return Number(m[1])}
// Mirrors remotion/semantic-motion-qa.mjs's own occupancy check exactly
// (same PNG decode, same 55-of-luminosity-distance threshold, same 15%
// floor) so this test regression-tests the metric a real render (scene11)
// actually failed on -- SSIM progression alone wouldn't catch a box that
// moves correctly but is nearly invisible against the background.
function occupancy(file){
  const b=fs.readFileSync(file);let p=8,w=0,h=0,c=0;const chunks=[];
  while(p<b.length){const n=b.readUInt32BE(p),t=b.toString("ascii",p+4,p+8),d=b.subarray(p+8,p+8+n);if(t==="IHDR"){w=d.readUInt32BE(0);h=d.readUInt32BE(4);c=d[9]}else if(t==="IDAT")chunks.push(d);else if(t==="IEND")break;p+=12+n}
  const channels=c===6?4:c===2?3:1,raw=zlib.inflateSync(Buffer.concat(chunks)),stride=w*channels,out=Buffer.alloc(h*stride);
  let q=0;
  for(let y=0;y<h;y++){const filter=raw[q++];for(let x=0;x<stride;x++){let v=raw[q++],a=x>=channels?out[y*stride+x-channels]:0,up=y?out[(y-1)*stride+x]:0,ul=x>=channels&&y?out[(y-1)*stride+x-channels]:0;if(filter===1)v+=a;else if(filter===2)v+=up;else if(filter===3)v+=(a+up)>>1;else if(filter===4){const pa=Math.abs(up-ul),pb=Math.abs(a-ul),pc=Math.abs(a+up-2*ul);v+=pa<=pb&&pa<=pc?a:pb<=pc?up:ul}out[y*stride+x]=v&255}}
  const left=Math.floor(w*.06),right=Math.ceil(w*.94),top=Math.floor(h*.08),bottom=Math.ceil(h*.9),corner=[out[0],out[1],out[2]];
  let hit=0,total=0;
  for(let y=top;y<bottom;y+=2)for(let x=left;x<right;x+=2){const i=(y*w+x)*channels,d=Math.abs(out[i]-corner[0])+Math.abs(out[i+1]-corner[1])+Math.abs(out[i+2]-corner[2]);if(d>55)hit++;total++}
  return hit/total;
}
// soda-container, soda-scale, soda-before-after, and soda-scale-cold-warm
// are the EXACT scenes from a real render (run_bd3de54c, a carbonation
// episode) that failed production motion QA -- pulled verbatim from that
// run's asset_manifest, not invented fixtures. soda-container authors
// "rotate"/"exit", neither of which is in container-object's own
// vocabulary; soda-scale authors "compare" on TWO separate windows, which
// used to make the first (earlier-saturating) window mask the second one's
// later progress via Math.max; soda-before-after authors a SINGLE window
// that doesn't start until ratio .7477, so the scene was legitimately,
// perfectly static for its first three quarters -- fixed not by inventing
// motion earlier than authored, but by giving the scene's otherwise-fixed
// elements a small continuous ambient breathing motion (shared.tsx's
// `breathe`); soda-scale-cold-warm's box was geometrically large enough
// but its #0C1C31 fill was only 35 of luminosity distance from the
// #08101E background, under the 55 threshold the QA gate's occupancy
// check counts as "foreground" -- fixed by contrast, not motion, which is
// why it needs its own occupancy assertion below rather than relying on
// the progression checks every other fixture uses. Kept alongside ice/
// onion/million-billion-trillion (whose hand-picked verbs and colors
// happened to already work, which is exactly why they never caught any of
// this) so these specific regressions can't silently return.
test("ice, onion, scale, and real-production benchmarks render specific progressing semantic scenes",{timeout:420000},()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"semantic-benchmarks-")),remotion=path.join(__dirname,"../remotion");try{run(process.execPath,["scripts/render-semantic-benchmarks.mjs",dir],{cwd:remotion});const manifest=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));assert.deepEqual(manifest.fixtures,["ice","onion","million-billion-trillion","soda-container","soda-scale","soda-before-after","soda-scale-cold-warm"]);for(const id of manifest.fixtures){const early=path.join(dir,`${id}-20.png`),middle=path.join(dir,`${id}-55.png`),late=path.join(dir,`${id}-85.png`);assert.ok(similarity(early,middle)<.9995,`${id} has no 20%-55% progression`);assert.ok(similarity(middle,late)<.9995,`${id} has no 55%-85% progression`)}assert.ok(similarity(path.join(dir,"ice-85.png"),path.join(dir,"onion-85.png"))<.97,"ice and onion silhouettes are too reusable");assert.ok(similarity(path.join(dir,"onion-85.png"),path.join(dir,"million-billion-trillion-85.png"))<.97,"onion and scale silhouettes are too reusable");for(const id of manifest.fixtures){
        // Matches semantic-motion-qa.mjs's real check exactly: the MAX
        // across the three samples must clear 15%, not every individual
        // sample -- a scene can legitimately open sparse and fill in
        // later. Checking each sample independently would be stricter
        // than production and could fail a fixture for no real reason.
        const best=Math.max(...[20,55,85].map((ratio)=>occupancy(path.join(dir,`${id}-${ratio}.png`))));
        assert.ok(best>=.15,`${id} foreground occupancy below 15% at every sample (best=${best})`);
      }}finally{fs.rmSync(dir,{recursive:true,force:true})}});
