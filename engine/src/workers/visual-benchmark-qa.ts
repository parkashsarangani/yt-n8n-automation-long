import { sampleRenderedFrames, type TimedFrame } from "../media/render-frame-sampler.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { compareRenderedVisualsBlind } from "../visual-benchmark-judge.ts";
import { scoreVisualBeatFrames, type QaImage } from "../visual-beat-qa.ts";
import type { VisualBeat, VisualBeatPlan } from "../visual-routing.ts";

interface TimelineBeat {
  id:string; ordinal:number; absolute_start_sec:number; absolute_end_sec:number; duration_sec:number;
  resolved_mode:string; composition:string; camera_treatment:string; subject_placement:string; explanatory_pattern:string;
}
interface VisualTimeline { beats:TimelineBeat[]; total_duration_sec:number }
interface RenderedVideo { video_uri:string; duration_sec?:number }

interface BeatResult {
  id:string;
  semantic_match:number; action_match:number; visual_interest:number; continuity:number;
  generic_filler:boolean; why_failure:boolean; repetitive:boolean;
  blind_winner:"v2"|"control"|"tie"; blind_reason:string;
  v2_blind_semantic:number; v2_blind_interest:number; control_blind_semantic:number; control_blind_interest:number;
  qa_reason:string;
}

function mean(values:number[]):number { return values.length?values.reduce((a,b)=>a+b,0)/values.length:0; }
function clampTime(value:number,end:number):number { return Math.max(0,Math.min(value,Math.max(0,end-.04))); }
function beatTimes(beat:TimelineBeat,total:number):number[]{
  const duration=Math.max(.12,beat.absolute_end_sec-beat.absolute_start_sec);
  return [.2,.5,.8].map((ratio)=>clampTime(beat.absolute_start_sec+duration*ratio,total));
}
function group(frames:TimedFrame[],index:number):QaImage[]{ return frames.slice(index*3,index*3+3).map(({bytes,media_type})=>({bytes,media_type})); }
function stableSwap(id:string):boolean { let hash=2166136261; for(const ch of id){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619);} return (hash>>>0)%2===1; }

export function makeVisualBenchmarkQaWorker():WorkerDef{
  return {
    name:"visual_benchmark_qa",kind:"worker",version:"1",
    consumes:[
      {schema_id:"visual_beat_plan",range:"^1",as:"plan"},
      {schema_id:"visual_timeline",range:"^1",as:"timeline"},
      {schema_id:"rendered_video",range:"^1",as:"control"},
      {schema_id:"rendered_video",range:"^1",as:"candidate"},
    ],
    produces:"visual_benchmark_report",produces_version:"1.0.0",
    async execute(inputs,ctx:WorkerContext):Promise<WorkerOutput>{
      const plan=inputs["plan"]!.payload as VisualBeatPlan;
      const timeline=inputs["timeline"]!.payload as VisualTimeline;
      const control=inputs["control"]!.payload as RenderedVideo;
      const candidate=inputs["candidate"]!.payload as RenderedVideo;
      const ordered=[...timeline.beats].sort((a,b)=>a.ordinal-b.ordinal);
      if(ordered.length<1||ordered.length>60) throw new Error(`visual benchmark requires 1-60 beats, got ${ordered.length}`);
      const planById=new Map(plan.beats.map((beat)=>[beat.id,beat]));
      const controlVideo=await ctx.blobs.get(control.video_uri), candidateVideo=await ctx.blobs.get(candidate.video_uri);
      const times=ordered.flatMap((beat)=>beatTimes(beat,timeline.total_duration_sec));
      const [controlFrames,candidateFrames]=await Promise.all([sampleRenderedFrames(controlVideo,times),sampleRenderedFrames(candidateVideo,times)]);
      const results:BeatResult[]=[];

      for(let index=0;index<ordered.length;index++){
        const timelineBeat=ordered[index]!, beat=planById.get(timelineBeat.id);
        if(!beat) throw new Error(`${timelineBeat.id}: timeline beat missing VisualBeat contract`);
        const v2=group(candidateFrames,index), old=group(controlFrames,index);
        const previous=index>0?group(candidateFrames,index-1)[1]:undefined;
        const next=index+1<ordered.length?group(candidateFrames,index+1)[1]:undefined;
        const absolute=await scoreVisualBeatFrames(v2,beat,{...(previous?{previous}:{}),...(next?{next}:{})});
        const swap=stableSwap(beat.id);
        const blind=await compareRenderedVisualsBlind(swap?old:v2,swap?v2:old,beat);
        const zero={semantic_match:0,action_match:0,visual_interest:0,continuity:0};
        const scores=absolute?.scores??zero;
        let blindWinner:"v2"|"control"|"tie"="tie",v2Semantic=0,v2Interest=0,controlSemantic=0,controlInterest=0,blindReason="visual comparison QA unavailable";
        if(blind){
          const winner=blind.winner;
          blindWinner=winner==="tie"?"tie":swap?(winner==="A"?"control":"v2"):(winner==="A"?"v2":"control");
          v2Semantic=swap?blind.b_semantic:blind.a_semantic; v2Interest=swap?blind.b_interest:blind.a_interest;
          controlSemantic=swap?blind.a_semantic:blind.b_semantic; controlInterest=swap?blind.a_interest:blind.b_interest; blindReason=blind.reason;
        }
        results.push({
          id:beat.id,...scores,generic_filler:absolute?.generic_filler??true,why_failure:absolute?.why_failure??true,
          repetitive:absolute?.repetitive_with_context??true,blind_winner:blindWinner,blind_reason:blindReason,
          v2_blind_semantic:v2Semantic,v2_blind_interest:v2Interest,control_blind_semantic:controlSemantic,control_blind_interest:controlInterest,
          qa_reason:absolute?.reason??"rendered-frame QA unavailable",
        });
        await ctx.progress({detail:`rendered visual QA ${index+1}/${ordered.length}: ${beat.id}`});
      }

      const semantics=results.map((r)=>r.semantic_match), interests=results.map((r)=>r.visual_interest);
      const whyFailures=results.filter((r)=>r.why_failure).length;
      const repetitiveCount=results.filter((r)=>r.repetitive).length;
      const fillerCount=results.filter((r)=>r.generic_filler).length;
      const continuityErrors=results.filter((r)=>{
        const beat=planById.get(r.id)!; const required=Boolean(beat.continuity.group||beat.continuity.entities.length); return required&&r.continuity<.70;
      }).length;
      const beatCount=results.length,repetitiveRatio=repetitiveCount/beatCount,fillerRatio=fillerCount/beatCount;
      const summary={
        beat_count:beatCount,mean_semantic_match:mean(semantics),min_semantic_match:Math.min(...semantics),
        mean_visual_interest:mean(interests),min_visual_interest:Math.min(...interests),why_failures:whyFailures,
        repetitive_count:repetitiveCount,repetitive_ratio:repetitiveRatio,continuity_errors:continuityErrors,
        generic_filler_count:fillerCount,generic_filler_ratio:fillerRatio,v2_wins:results.filter((r)=>r.blind_winner==="v2").length,
        control_wins:results.filter((r)=>r.blind_winner==="control").length,ties:results.filter((r)=>r.blind_winner==="tie").length,
      };
      const failures:string[]=[];
      if(summary.min_semantic_match<.90) failures.push(`semantic match floor ${summary.min_semantic_match.toFixed(3)} < 0.90`);
      if(summary.min_visual_interest<.80) failures.push(`visual interest floor ${summary.min_visual_interest.toFixed(3)} < 0.80`);
      if(summary.why_failures!==0) failures.push(`why-am-I-seeing-this failures ${summary.why_failures} > 0`);
      if(summary.repetitive_ratio>.10) failures.push(`repetitive visual ratio ${summary.repetitive_ratio.toFixed(3)} > 0.10`);
      if(summary.continuity_errors!==0) failures.push(`continuity errors ${summary.continuity_errors} > 0`);
      if(summary.generic_filler_ratio>.05) failures.push(`generic filler ratio ${summary.generic_filler_ratio.toFixed(3)} > 0.05`);
      return {payload:{pass:failures.length===0,failures,beats:results,summary}};
    },
  };
}
