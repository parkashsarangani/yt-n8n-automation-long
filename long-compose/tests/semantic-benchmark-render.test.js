const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process"),test=require("node:test"),ffmpeg=require("ffmpeg-static");
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:"utf8",timeout:360000,...options});assert.equal(result.status,0,result.stderr||result.stdout)}
function similarity(a,b){const r=spawnSync(ffmpeg,["-hide_banner","-i",a,"-i",b,"-lavfi","ssim","-f","null","-"],{encoding:"utf8",timeout:60000}),m=(r.stderr+r.stdout).match(/All:([0-9.]+)/);assert.ok(m);return Number(m[1])}
// soda-container, soda-scale, and soda-before-after are the EXACT scenes
// from a real render (run_bd3de54c, a carbonation episode) that failed
// production motion QA -- pulled verbatim from that run's asset_manifest,
// not invented fixtures. soda-container authors "rotate"/"exit", neither of
// which is in container-object's own vocabulary; soda-scale authors
// "compare" on TWO separate windows, which used to make the first
// (earlier-saturating) window mask the second one's later progress via
// Math.max; soda-before-after authors a SINGLE window that doesn't start
// until ratio .7477, so the scene was legitimately, perfectly static for
// its first three quarters -- fixed not by inventing motion earlier than
// authored, but by giving the scene's otherwise-fixed elements (the
// reference dots, the "before" circle) a small continuous ambient
// breathing motion (shared.tsx's `breathe`), the same pattern
// MoleculeSystemScene/ParticleSystemScene already used successfully. Kept
// alongside ice/onion/million-billion-trillion (whose hand-picked verbs
// happened to already match, which is exactly why they never caught any of
// this) so these specific regressions can't silently return.
test("ice, onion, scale, and real-production benchmarks render specific progressing semantic scenes",{timeout:420000},()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"semantic-benchmarks-")),remotion=path.join(__dirname,"../remotion");try{run(process.execPath,["scripts/render-semantic-benchmarks.mjs",dir],{cwd:remotion});const manifest=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));assert.deepEqual(manifest.fixtures,["ice","onion","million-billion-trillion","soda-container","soda-scale","soda-before-after"]);for(const id of manifest.fixtures){const early=path.join(dir,`${id}-20.png`),middle=path.join(dir,`${id}-55.png`),late=path.join(dir,`${id}-85.png`);assert.ok(similarity(early,middle)<.9995,`${id} has no 20%-55% progression`);assert.ok(similarity(middle,late)<.9995,`${id} has no 55%-85% progression`)}assert.ok(similarity(path.join(dir,"ice-85.png"),path.join(dir,"onion-85.png"))<.97,"ice and onion silhouettes are too reusable");assert.ok(similarity(path.join(dir,"onion-85.png"),path.join(dir,"million-billion-trillion-85.png"))<.97,"onion and scale silhouettes are too reusable")}finally{fs.rmSync(dir,{recursive:true,force:true})}});
