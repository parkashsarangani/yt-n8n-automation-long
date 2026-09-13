// Reproducible offline render for inspecting cards, captions and transitions.
// Synthetic flite speech is a layout/timing fixture, not production voice QA.
const fs=require("node:fs/promises");
const {promisify}=require("node:util");
const exec=promisify(require("node:child_process").execFile);
const {buildAudioFirstVideo}=require("../compose");
async function main(){
  const dir=process.argv[2]||"/outputs";
  await fs.mkdir(dir,{recursive:true});
  const beats=[
    {point:"[scenario] A second invitation",narration:"You already invited them once. Their answer was vague. Ask once, then leave room to decline.",visual:{kind:"quote",title:"Leave room for an honest answer",items:["Ask once, then leave room to decline."]}},
    {point:"[response_b] Change the wording",narration:"You could say, why have you not replied? Or try, no pressure if this week does not work.",visual:{kind:"comparison",title:"Pressure or an easy way out",items:["why have you not replied?","no pressure if this week does not work."]}},
    {point:"[exercise] Make the choice concrete",narration:"Name one specific plan. Give them time to answer. Accept a clear no.",visual:{kind:"steps",title:"A clear invitation",items:["Name one specific plan.","Give them time to answer.","Accept a clear no."]}},
    {point:"[payoff] One invitation is enough",narration:"The aim is an honest answer, not a forced yes. Which wording would you use, and why?",visual:{kind:"quote",title:"The useful outcome",items:["The aim is an honest answer, not a forced yes."]}}
  ];
  const scenes=[];
  for(const [i,beat] of beats.entries()){
    const file=dir+"/voice-"+i+".wav";
    await exec("ffmpeg",["-y","-f","lavfi","-i","flite=text='"+beat.narration+"':voice=slt",file]);
    scenes.push({...beat,scene_index:i,audio:{audio_base64:(await fs.readFile(file)).toString("base64"),media_type:"audio/wav"}});
  }
  await buildAudioFirstVideo(scenes,dir+"/visual-review.mp4",{lesson_title:"When a follow-up becomes pressure"});
  await exec("ffmpeg",["-y","-i",dir+"/visual-review.mp4","-vf","fps=1/3,scale=640:360,tile=3x3","-frames:v","1",dir+"/contact-sheet.png"]);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
