const fs = require('node:fs/promises');
const path = require('node:path');
const {concatPath} = require('./concat-path');

// Render one scene at a time, then concatenate. Resource use does not grow
// with the number of simultaneous video decoders in the final compositor.
async function buildStockTrack(scenes, durations, shots, directory, {ffmpeg, exec, warn = console.warn}) {
  if (!shots.length) return {file:null,shots:[]};
  const segments = [], accepted = [];
  let elapsed = 0;
  for (let i=0;i<scenes.length;i++) {
    const shot = shots.find(s=>s.scene_index===scenes[i].scene_index);
    const sceneIndex = scenes[i].scene_index;
    const firstFrame = Math.round(elapsed*30); elapsed += durations[i];
    // Consecutive unmatched scenes share one background encode. Round only
    // cumulative boundaries so grouping cannot accumulate caption drift.
    if (!shot) while (i+1<scenes.length && !shots.some(s=>s.scene_index===scenes[i+1].scene_index)) elapsed+=durations[++i];
    const frames = Math.round(elapsed*30)-firstFrame;
    if (frames <= 0) continue;
    const file = path.join(directory,`stock-segment-${i}.mp4`);
    const output = ['-an','-frames:v',String(frames),'-r','30','-c:v','libx264','-threads','2',
      '-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-video_track_timescale','15360',file];
    let rendered = false;
    if (shot) {
      try {
        await exec(ffmpeg,['-y','-v','error','-threads','2',
          ...(shot.kind==='photo'?['-loop','1','-framerate','30']:[]),'-i',shot.file,
          '-vf','fps=30,scale=1920:810:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:floor((810-ih)/4)*2:color=0x101217,setsar=1,tpad=stop_mode=clone:stop_duration='+frames/30,
          ...output],{timeout:120_000});
        rendered = true; accepted.push(shot);
      } catch { warn(`Stock scene ${sceneIndex} could not be decoded; using background`); }
    }
    if (!rendered) await exec(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=c=0x101217:s=1920x1080:r=30',...output],{timeout:120_000});
    segments.push(file);
  }
  const list = path.join(directory,'stock-concat.txt');
  await fs.writeFile(list,segments.map(file=>`file '${concatPath(file)}'`).join('\n'));
  const file = path.join(directory,'stock-track.mp4');
  await exec(ffmpeg,['-y','-v','error','-f','concat','-safe','0','-i',list,'-c','copy',file],{timeout:120_000});
  return {file,shots:accepted};
}
module.exports = {buildStockTrack};
