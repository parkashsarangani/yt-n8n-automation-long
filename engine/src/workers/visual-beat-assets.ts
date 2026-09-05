import type { BlobRef } from "../artifact.ts";
import { checkGeneratedImageForText, checkGeneratedImageMatchesNarration } from "../image-qa.ts";
import { candidateWindows, extractVideoSegment, sampleVideoFrames } from "../media/video-analysis.ts";
import { FalVideoProvider } from "../providers/fal-video.ts";
import { PexelsVideoProvider, type StockVideoCandidate } from "../providers/pexels-video.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { scoreVisualBeatFrames, scoreVisualBeatImage, type QaImage, type VisualBeatQaResult } from "../visual-beat-qa.ts";
import {
  candidateAccepted,
  chooseVisualCandidate,
  historyEntryForBeat,
  selectVisualMode,
  validateVisualBeatPlan,
  weightedVisualScore,
  type CandidateScores,
  type ScoredCandidate,
  type VisualBeat,
  type VisualBeatPlan,
  type VisualCapabilities,
  type VisualHistoryEntry,
  type VisualMode,
} from "../visual-routing.ts";

export interface VisualBeatAssetsWorkerOptions { version?: string }

interface ResolvedBeat {
  id: string; scene_index: number; beat_index: number; start_sec: number; end_sec: number;
  requested_mode: VisualMode; resolved_mode: VisualMode | null; status: "resolved" | "fallback" | "unavailable";
  semantic_verified: boolean; narration: string; viewer_takeaway: string;
  composition: string; camera_treatment: string; subject_placement: string; explanatory_pattern: string;
  image_uri?: string; video_uri?: string; preview_uri?: string;
  source_provider?: string; source_id?: string; source_url?: string; source_in_sec?: number; source_out_sec?: number;
  template_category?: "explanation"; template_data?: string;
  semantic_match?: number; action_match?: number; visual_interest?: number; continuity?: number;
  generic_filler?: boolean; why_failure?: boolean; candidate_count?: number; note?: string;
}
interface ModeResult extends Partial<ResolvedBeat> { blobs?: BlobRef[]; preview?: QaImage }

function capabilities(): VisualCapabilities {
  return {
    stock_video: Boolean(process.env["PEXELS_API_KEY"]?.trim()),
    generated_image: true,
    motion_graphic: true,
    generated_video: Boolean(process.env["FAL_KEY"]?.trim()),
  };
}

function scored<T>(value: T, qa: VisualBeatQaResult): ScoredCandidate<T> { return { value, scores: qa.scores }; }
function qaFields(qa: VisualBeatQaResult): Partial<ResolvedBeat> {
  return { ...qa.scores, generic_filler: qa.generic_filler, why_failure: qa.why_failure, semantic_verified: candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure };
}
function promptsForBeat(beat: VisualBeat): string[] {
  const raw = beat.asset_brief.generation_variants?.length ? beat.asset_brief.generation_variants : [beat.asset_brief.generation_prompt];
  return raw.filter((x) => x.trim()).slice(0, 5);
}
function queriesForBeat(beat: VisualBeat): string[] {
  const raw = beat.asset_brief.query_variants?.length ? beat.asset_brief.query_variants : [beat.asset_brief.query];
  return raw.filter((x) => x.trim()).slice(0, 5);
}
function strengthenedPrompt(beat: VisualBeat, concept: string): string {
  const style = beat.routing.image_style === "illustration"
    ? "Purposeful editorial illustration; specific physical staging, not generic decorative art."
    : "Photorealistic/cinematic real-world visual language unless the subject itself is abstract.";
  return [concept, style,
    `VIEWER TAKEAWAY: ${beat.visual_contract.viewer_takeaway}.`,
    `MUST SHOW: ${beat.visual_contract.required.join("; ")}.`,
    beat.visual_contract.required_action ? `ACTION/STATE: ${beat.visual_contract.required_action}.` : "",
    beat.visual_contract.forbidden.length ? `EXCLUDE: ${beat.visual_contract.forbidden.join("; ")}.` : "",
    `COMPOSITION: ${beat.retention.composition}; CAMERA: ${beat.retention.camera_treatment ?? "appropriate"}; SUBJECT: ${beat.retention.subject_placement ?? "appropriate"}.`,
    beat.continuity.group ? `CONTINUITY: group ${beat.continuity.group}; recurring entity ids ${beat.continuity.entities.join(", ") || "none"}. Preserve their physical identity.` : "",
    "No readable text, letters, numbers, logos, subtitles, captions, watermarks, UI or accidental typography.",
  ].filter(Boolean).join(" ");
}

async function generatedImage(beat: VisualBeat, ctx: WorkerContext, previous?: QaImage): Promise<ModeResult> {
  const provider = ctx.media.images;
  if (!provider) throw new Error("generated_image requires an image provider");
  if (provider.id.toLowerCase().includes("freellmapi")) throw new Error(`RFC 0010 forbids FreeLLMAPI image generation (${provider.id})`);
  const concepts = promptsForBeat(beat);
  if (concepts.length < 3) throw new Error(`${beat.id}: Visual Director supplied fewer than 3 image candidates`);

  const candidates: Array<{ image: QaImage; qa: VisualBeatQaResult; prompt: string }> = [];
  const failures: string[] = [];
  for (const concept of concepts) {
    try {
      const out = await provider.generate({ prompt: strengthenedPrompt(beat, concept), aspect: "16:9", count: 1, tier: beat.hero_role ? "hero" : "standard" });
      const image = out.images[0]; if (!image) continue;
      const [textQa, contradictionQa, beatQa] = await Promise.all([
        checkGeneratedImageForText(image), checkGeneratedImageMatchesNarration(image, beat.narration), scoreVisualBeatImage(image, beat, undefined, previous ? { previous } : {}),
      ]);
      if (!textQa || !contradictionQa || !beatQa) { failures.push("QA unavailable"); continue; }
      if (textQa.hasVisibleText) { failures.push(`text: ${textQa.reason}`); continue; }
      if (contradictionQa.contradictsNarration) { failures.push(`contradiction: ${contradictionQa.reason}`); continue; }
      if (beatQa.generic_filler || beatQa.why_failure) { failures.push(`filler: ${beatQa.reason}`); continue; }
      candidates.push({ image, qa: beatQa, prompt: concept });
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  const best = chooseVisualCandidate(candidates.map((c) => scored(c, c.qa)));
  if (!best) throw new Error(`no generated-image candidate cleared the visual gate: ${failures.slice(0,3).join(" | ")}`);
  const chosen = best.value;
  const ref = await ctx.blobs.put(chosen.image.bytes, { role: "image", media_type: chosen.image.media_type });
  return { image_uri: ref.uri, preview_uri: ref.uri, blobs: [ref], preview: chosen.image, candidate_count: concepts.length, source_provider: provider.id, ...qaFields(chosen.qa) };
}

interface WindowCandidate { source: StockVideoCandidate; start: number; end: number; frames: QaImage[]; qa: VisualBeatQaResult }
async function stockVideo(beat: VisualBeat, ctx: WorkerContext, previous?: QaImage): Promise<ModeResult> {
  const pexels = new PexelsVideoProvider();
  const queries = queriesForBeat(beat);
  if (queries.length < 3) throw new Error(`${beat.id}: Visual Director supplied fewer than 3 stock query variants`);
  let evaluated = 0;
  for (const query of queries) {
    const sources = await pexels.search(query, 5);
    const accepted: WindowCandidate[] = [];
    for (const source of sources) {
      const windows = candidateWindows(source.duration_sec, Math.max(2.5, beat.end_sec - beat.start_sec), 5);
      for (const window of windows) {
        evaluated++;
        try {
          const sampled = await sampleVideoFrames(source.bytes, window.start, window.end, 5);
          const frames = sampled.map((f) => ({ bytes: f.bytes, media_type: f.media_type }));
          const qa = await scoreVisualBeatFrames(frames, beat, previous ? { previous } : {});
          if (qa && candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure) accepted.push({ source, start: window.start, end: window.end, frames, qa });
        } catch (error) { ctx.logger.warn(`[visual_beat_assets] ${beat.id} stock window rejected: ${String(error)}`); }
      }
    }
    accepted.sort((a,b) => weightedVisualScore(b.qa.scores)-weightedVisualScore(a.qa.scores));
    const best = accepted[0];
    // RFC 0010: materially different query is tried only when the current query
    // produced no semantically admissible segment.
    if (!best) continue;
    const segment = await extractVideoSegment(best.source.bytes, best.start, best.end);
    const videoRef = await ctx.blobs.put(segment, { role: "video", media_type: "video/mp4" });
    const preview = best.frames[Math.floor(best.frames.length / 2)]!;
    const previewRef = await ctx.blobs.put(preview.bytes, { role: "image", media_type: preview.media_type });
    return {
      video_uri: videoRef.uri, preview_uri: previewRef.uri, blobs: [videoRef, previewRef], preview,
      source_provider: "pexels", source_id: best.source.id, source_url: best.source.source_url,
      source_in_sec: best.start, source_out_sec: best.end, candidate_count: evaluated, ...qaFields(best.qa),
    };
  }
  throw new Error(`no Pexels candidate/window cleared semantic gate after ${evaluated} evaluated windows and ${queries.length} materially different queries`);
}

function semanticTemplate(beat: VisualBeat): ModeResult {
  const brief = beat.asset_brief.motion_graphic_brief.trim();
  if (!brief) throw new Error(`${beat.id}: motion_graphic has no deterministic brief`);
  const pattern = beat.retention.explanatory_pattern ?? "reveal";
  const map: Record<string, { representationMode: string; sceneBlueprint: string }> = {
    map: { representationMode: "spatial", sceneBlueprint: "map" },
    timeline: { representationMode: "temporal", sceneBlueprint: "timeline" },
    comparison: { representationMode: "quantitative", sceneBlueprint: "scale-comparison" },
    counter: { representationMode: "quantitative", sceneBlueprint: "scale-comparison" },
    process: { representationMode: "domain-model", sceneBlueprint: "flow-system" },
    cause_effect: { representationMode: "domain-model", sceneBlueprint: "flow-system" },
  };
  const semantic = map[pattern] ?? { representationMode: "kinetic-text", sceneBlueprint: "animated-statement" };
  return {
    template_category: "explanation",
    template_data: JSON.stringify({
      ...semantic, visualClaim: beat.visual_contract.viewer_takeaway,
      keyText: beat.visual_contract.viewer_takeaway,
      elements: beat.visual_contract.required,
      semanticEntities: beat.continuity.entities.map((entity_id, i) => ({ entity_id, label: beat.visual_contract.required[i] ?? entity_id, depiction: { kind: "concept", appearance: beat.visual_contract.required[i] ?? entity_id, color: "neutral" } })),
      semanticActionWindows: beat.visual_contract.required_action ? [{ actor: beat.continuity.entities[0] ?? "subject", action: beat.visual_contract.required_action, target: beat.continuity.entities[1] ?? "state", startRatio: 0.15, endRatio: 0.85, aligned: true }] : [],
      rfc0010Brief: brief,
    }),
    semantic_verified: false,
    candidate_count: 1,
  };
}

async function generatedVideo(beat: VisualBeat, ctx: WorkerContext, previous?: QaImage): Promise<ModeResult> {
  if (!beat.hero_role && beat.intent.importance < 0.85) throw new Error(`${beat.id}: generated video reserved for high-value/hero beats`);
  const provider = new FalVideoProvider();
  const concepts = promptsForBeat(beat).slice(0,3);
  const motion = beat.asset_brief.generated_video_prompt?.trim() || beat.asset_brief.generation_prompt;
  const accepted: Array<{ bytes: Uint8Array; frames: QaImage[]; qa: VisualBeatQaResult; model: string; duration: number }> = [];
  for (const concept of concepts) {
    try {
      const video = await provider.generate(`${concept}. MOTION: ${motion}`, Math.max(5, beat.end_sec-beat.start_sec));
      const sampled = await sampleVideoFrames(video.bytes, 0, video.duration_sec, 5);
      const frames = sampled.map((f) => ({ bytes: f.bytes, media_type: f.media_type }));
      const qa = await scoreVisualBeatFrames(frames, beat, previous ? { previous } : {});
      if (qa && candidateAccepted(qa.scores) && !qa.generic_filler && !qa.why_failure) accepted.push({ bytes: video.bytes, frames, qa, model: video.model, duration: video.duration_sec });
    } catch (error) { ctx.logger.warn(`[visual_beat_assets] ${beat.id} generated-video candidate failed: ${String(error)}`); }
  }
  accepted.sort((a,b) => weightedVisualScore(b.qa.scores)-weightedVisualScore(a.qa.scores));
  const best=accepted[0]; if (!best) throw new Error(`no generated-video candidate cleared visual gate (${concepts.length} attempted)`);
  const wanted = Math.min(best.duration, Math.max(2.5, beat.end_sec-beat.start_sec));
  const segment = wanted < best.duration ? await extractVideoSegment(best.bytes, 0, wanted) : best.bytes;
  const videoRef=await ctx.blobs.put(segment,{role:"video",media_type:"video/mp4"});
  const preview=best.frames[Math.floor(best.frames.length/2)]!;
  const previewRef=await ctx.blobs.put(preview.bytes,{role:"image",media_type:preview.media_type});
  return { video_uri:videoRef.uri,preview_uri:previewRef.uri,blobs:[videoRef,previewRef],preview,source_provider:"fal",source_id:best.model,source_in_sec:0,source_out_sec:wanted,candidate_count:concepts.length,...qaFields(best.qa) };
}

async function resolveMode(beat: VisualBeat, mode: VisualMode, ctx: WorkerContext, previous?: QaImage): Promise<ModeResult> {
  if (mode==="generated_image") return generatedImage(beat,ctx,previous);
  if (mode==="stock_video") return stockVideo(beat,ctx,previous);
  if (mode==="generated_video") return generatedVideo(beat,ctx,previous);
  return semanticTemplate(beat);
}
function alternateMode(beat: VisualBeat,current:VisualMode):VisualMode|null { return current===beat.routing.preferred?beat.routing.fallback:current===beat.routing.fallback?beat.routing.preferred:null; }

export function makeVisualBeatAssetsWorker(opts: VisualBeatAssetsWorkerOptions = {}): WorkerDef {
  return { name:"visual_beat_assets",kind:"worker",version:opts.version??"2",consumes:[{schema_id:"visual_beat_plan",range:"^1",as:"plan"}],produces:"visual_beat_assets",produces_version:"1.0.0",
    async execute(inputs,ctx:WorkerContext):Promise<WorkerOutput>{
      const plan=inputs["plan"]!.payload as VisualBeatPlan; const validation=validateVisualBeatPlan(plan); if(validation.length) throw new Error(`visual beat plan invariant failed: ${validation.join("; ")}`);
      const ordered=[...plan.beats].sort((a,b)=>a.scene_index-b.scene_index||a.beat_index-b.beat_index), history:VisualHistoryEntry[]=[], blobs:BlobRef[]=[], beats:ResolvedBeat[]=[]; let previousPreview:QaImage|undefined;
      const caps=capabilities();
      for(const beat of ordered){
        const requested=beat.routing.preferred; let selected=selectVisualMode(beat,history,caps), result:ModeResult|null=null,note="";
        if(selected){ try{ result=await resolveMode(beat,selected,ctx,previousPreview); }
          catch(error){ note=error instanceof Error?error.message:String(error); const alternate=alternateMode(beat,selected); if(alternate&&caps[alternate]){ try{ selected=alternate; result=await resolveMode(beat,selected,ctx,previousPreview); note=`primary route failed; used declared alternate: ${note}`; } catch(second){ note=`${note}; alternate failed: ${second instanceof Error?second.message:String(second)}`; selected=null; } } else selected=null; }
        } else note="neither agent-declared mode is available";
        if(result?.blobs) blobs.push(...result.blobs); if(result?.preview) previousPreview=result.preview;
        const resolved:ResolvedBeat={ id:beat.id,scene_index:beat.scene_index,beat_index:beat.beat_index,start_sec:beat.start_sec,end_sec:beat.end_sec,requested_mode:requested,resolved_mode:selected,status:selected?(selected===requested?"resolved":"fallback"):"unavailable",semantic_verified:Boolean(result?.semantic_verified),narration:beat.narration,viewer_takeaway:beat.visual_contract.viewer_takeaway,composition:beat.retention.composition,camera_treatment:beat.retention.camera_treatment??"unknown",subject_placement:beat.retention.subject_placement??"unknown",explanatory_pattern:beat.retention.explanatory_pattern??"unknown",...result,...(note?{note}:{}) };
        delete (resolved as ModeResult).blobs; delete (resolved as ModeResult).preview;
        if(selected) history.push(historyEntryForBeat(beat,selected)); beats.push(resolved);
      }
      const summary={ resolved:beats.filter(b=>b.status==="resolved").length,fallbacks:beats.filter(b=>b.status==="fallback").length,unavailable:beats.filter(b=>b.status==="unavailable").length,stock_videos:beats.filter(b=>b.resolved_mode==="stock_video").length,generated_images:beats.filter(b=>b.resolved_mode==="generated_image").length,motion_graphics:beats.filter(b=>b.resolved_mode==="motion_graphic").length,generated_videos:beats.filter(b=>b.resolved_mode==="generated_video").length,generic_filler:beats.filter(b=>b.generic_filler).length,why_failures:beats.filter(b=>b.why_failure).length };
      return {payload:{beats,summary},blobs};
    }};
}
