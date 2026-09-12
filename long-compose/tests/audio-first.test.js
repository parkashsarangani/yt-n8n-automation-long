const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const { app, buildAudioFirstVideo, historyPathFor } = require("../compose.js");

function silentWav(sampleRate = 24000, durationSec = 0.2) {
  const samples = Math.max(1, Math.round(sampleRate * durationSec));
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

function scene(sceneIndex, durationSec = 0.2) {
  return {
    scene_index: sceneIndex,
    audio: {
      audio_base64: silentWav(24000, durationSec).toString("base64"),
      media_type: "audio/wav",
    },
  };
}

test("audio-first compositor exports an express app", () => {
  assert.equal(typeof app, "function");
});

test("thumbnail endpoint renders gradient and supplied artwork through bundled FFmpeg", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/thumbnail`;
    let image;
    for (const background of ["gradient", "supplied"]) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "LET ME FINISH {literal}", ...(image ? { image_base64: image } : {}) }) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.background, background);
      const bytes = Buffer.from(body.image_base64, "base64");
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.equal(bytes.readUInt32BE(16), 1280);
      assert.equal(bytes.readUInt32BE(20), 720);
      image = body.image_base64;
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("topic history is isolated and sanitized by niche", () => {
  assert.equal(path.basename(historyPathFor("History & Mystery")), "topic_history_HistoryMystery.json");
  assert.equal(path.basename(historyPathFor("../")), "topic_history_default.json");
});

test("audio-first render concatenates narration into a valid MP4 shell", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "audio-first-test-"));
  const output = path.join(dir, "out.mp4");
  try {
    const duration = await buildAudioFirstVideo([scene(1, 0.15), scene(0, 0.2)], output);
    const bytes = await fsp.readFile(output);
    assert.ok(duration > 0.25, `expected concatenated narration duration, got ${duration}`);
    assert.ok(bytes.length > 1024, "expected a non-empty encoded MP4");
    assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("audio-first render rejects an empty programme", async () => {
  await assert.rejects(() => buildAudioFirstVideo([], "/tmp/unused.mp4"), /at least one audio scene/);
});

test("quiet programme is normalized without changing its timeline", async () => {
  const {promisify}=require("node:util");
  const exec=promisify(require("node:child_process").execFile);
  const bundled=require("ffmpeg-static");
  const ffmpeg=process.env.FFMPEG_PATH || (bundled && fs.existsSync(bundled) ? bundled : "ffmpeg");
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),"programme-level-"));
  try {
    const wav=silentWav(24000,4);
    for(let i=0;i<96000;i++)wav.writeInt16LE(Math.round(500*Math.sin(2*Math.PI*440*i/24000)),44+i*2);
    const output=path.join(dir,"out.mp4");
    const duration=await buildAudioFirstVideo([{scene_index:0,audio:{audio_base64:wav.toString("base64"),media_type:"audio/wav"}}],output);
    assert.ok(Math.abs(duration-4)<0.1);
    const result=await exec(ffmpeg,["-hide_banner","-nostats","-i",output,"-af","loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json","-f","null","-"]);
    const levels=JSON.parse(result.stderr.slice(result.stderr.lastIndexOf("{"), result.stderr.lastIndexOf("}")+1));
    assert.ok(Math.abs(Number(levels.input_i)+16)<1,JSON.stringify(levels));
    assert.ok(Number(levels.input_tp)<=-1,JSON.stringify(levels));
  } finally {await fsp.rm(dir,{recursive:true,force:true});}
});

test("subtitle safe band occludes even a white text-bearing background", async () => {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),"caption-contrast-"));
  try {
    const output=path.join(dir,"out.mp4");
    const ppm=Buffer.concat([Buffer.from("P6\n2 2\n255\n"),Buffer.alloc(12,255)]);
    await buildAudioFirstVideo([{...scene(0,0.5),narration:"Readable words."}],output,{image_base64:ppm.toString("base64")});
    const {promisify}=require("node:util");
    const exec=promisify(require("node:child_process").execFile);
    const bundled=require("ffmpeg-static");
    const result=await exec(fs.existsSync(bundled)?bundled:"ffmpeg",["-v","error","-i",output,"-vf","crop=4:4:10:900,format=rgb24","-frames:v","1","-f","rawvideo","pipe:1"],{encoding:"buffer"});
    assert.ok([...result.stdout].every(v=>v<35),"image pixels must not show through subtitle band");
  } finally {await fsp.rm(dir,{recursive:true,force:true});}
});

test("conversation cards render through FFmpeg with literal untrusted text", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conversation-test-"));
  try {
    const output=path.join(dir,"stage.mp4");
    const duration=await buildAudioFirstVideo([{...scene(0,1),point:"[response_b] example",narration:"Let me finish this thought, then I would like to hear yours. {literal} \\pos(0,0)"}],output);
    assert.ok(duration >= 1);
    assert.ok((await fsp.stat(output)).size > 5000);
  } finally { await fsp.rm(dir,{recursive:true,force:true}); }
});

test("audio-first render rejects invalid scene identity before encoding", async () => {
  await assert.rejects(
    () => buildAudioFirstVideo([{ ...scene(0), scene_index: 0.5 }], "/tmp/unused.mp4"),
    /scene_index values must be unique integers/,
  );
});
