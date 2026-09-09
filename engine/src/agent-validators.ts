/** Per-agent semantic validation hook (RFC 0003). */
import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";
import { validateGrowthPackageReleaseability } from "./growth-package-contract.ts";
import { fallbackContractErrors, type QualityBeatLike } from "./visual-beat-quality.ts";
import { validateSemanticScene, type SemanticScene } from "./semantic-scene.ts";

export const HARD_ERROR_PREFIX = "HARD:";
export function hasHardSemanticError(errors: string[]): boolean { return errors.some((e) => e.startsWith(HARD_ERROR_PREFIX)); }

type DirectionShot = { image_prompt?: unknown };
type DirectionScene = { scene_index?: unknown; shots?: unknown };
type DirectionPayload = { scenes?: unknown };
type GrowthPayload = { next_video_bridge?: unknown };
type VisualPlanBeat = { id?: unknown; scene_index?: unknown; beat_index?: unknown; narration?: unknown };
type VisualPlanPayload = { beats?: unknown };
type ScriptScene = { scene_index?: unknown; narration?: unknown };

const TEXT_BEARING_SURFACE = /\b(document|paper|chart|form|letter|note|sign|poster|screen|monitor|phone|tablet|directory|contract|badge|name\s*tag|label|menu|receipt|ticket|book|newspaper|clipboard|whiteboard|blackboard|spreadsheet|list|certificate)\b/i;
const READABLE_TEXT_SIGNAL = /\b(readable|legible|printed|written|labeled|labelled|names?|words?|text|writing|letters?|numbers?|dates?|signature|address|headline|title|caption|prices?|scores?|rows?|columns?)\b/i;
const SAFE_TEXT_FRAMING = /\b(face[- ]?down|turned away|back(?: side)? facing|closed|folded|blank|unreadable|illegible|blurred|out[- ]?of[- ]?focus|distant|cropped|obscured|covered|screen off|dark screen|no visible (?:text|writing)|without readable (?:text|writing))\b/i;
const GENERIC_ENGAGEMENT = /\b(like|subscribe|follow|comment|share|hit (?:the )?bell|notification bell)\b/i;
const GENERIC_CONTINUATION = /\b(stay tuned|more like this|what happens next|watch (?:the )?(?:next|another) (?:video|episode)|check out (?:the )?(?:next|another) (?:video|episode))\b/i;

export function unsafeDirectionTextPrompts(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const scenes = Array.isArray((payload as DirectionPayload).scenes) ? (payload as DirectionPayload).scenes as DirectionScene[] : [];
  const errors: string[] = [];
  for (const scene of scenes) {
    const shots = Array.isArray(scene?.shots) ? scene.shots as DirectionShot[] : [];
    shots.forEach((shot, shotIndex) => {
      const prompt = typeof shot?.image_prompt === "string" ? shot.image_prompt.trim() : "";
      if (!prompt) return;
      if (TEXT_BEARING_SURFACE.test(prompt) && READABLE_TEXT_SIGNAL.test(prompt) && !SAFE_TEXT_FRAMING.test(prompt)) {
        const sceneIndex = typeof scene.scene_index === "number" ? scene.scene_index : "?";
        errors.push(`scene ${sceneIndex} shot ${shotIndex} asks a text-bearing object to carry readable writing; depict the physical object/action with its face blank, closed, face-down, turned away, distant, cropped, or otherwise unreadable`);
      }
    });
  }
  return errors;
}

export function continuationBridgeErrors(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const bridge = typeof (payload as GrowthPayload).next_video_bridge === "string" ? ((payload as GrowthPayload).next_video_bridge as string).trim() : "";
  if (!bridge) return [];
  const errors: string[] = [];
  if (GENERIC_ENGAGEMENT.test(bridge)) errors.push("next_video_bridge must continue the viewing session, not ask for likes/subscriptions/follows/comments/shares");
  if (GENERIC_CONTINUATION.test(bridge)) errors.push("next_video_bridge must name or imply a specific adjacent story/question instead of generically saying to watch another video");
  return errors;
}

/**
 * Partition immutable script text into N contiguous chunks near phrase/sentence
 * boundaries. The model chooses how many semantic beats a scene needs; the
 * engine owns the exact bytes. This removes a costly/fragile requirement for a
 * structured-output model to manually retype the approved narration.
 */
export function splitApprovedNarration(text: string, count: number): string[] {
  if (count <= 1) return [text];
  const boundaries: number[] = [];
  for (let i = 1; i < text.length; i++) {
    if (/[.!?;:]/.test(text[i - 1]!)) boundaries.push(i);
    else if (text[i - 1] === "," && /\s/.test(text[i]!)) boundaries.push(i);
  }
  const cuts = [0];
  for (let part = 1; part < count; part++) {
    const target = Math.round(text.length * part / count);
    const min = cuts[cuts.length - 1]! + 1;
    const max = text.length - (count - part);
    const candidates = boundaries.filter((b) => b >= min && b <= max);
    let cut = candidates.sort((a,b) => Math.abs(a-target)-Math.abs(b-target))[0];
    if (cut === undefined) {
      let right = target;
      while (right < max && !/\s/.test(text[right]!)) right++;
      let left = target;
      while (left > min && !/\s/.test(text[left]!)) left--;
      cut = right <= max && Math.abs(right-target) <= Math.abs(left-target) ? right : Math.max(min,left);
    }
    cuts.push(cut);
  }
  cuts.push(text.length);
  return cuts.slice(0,-1).map((start,i)=>text.slice(start,cuts[i+1]!));
}

/**
 * Canonicalize beat narration in-place from the immutable approved script.
 * Schema validation has already proved `narration` is a string; this repair
 * only changes its contents and preserves the model's beat count/semantics.
 */
export function repairVisualDirectorNarration(payload: unknown, scriptPayload: unknown): string[] {
  const beats = payload && typeof payload === "object" && Array.isArray((payload as VisualPlanPayload).beats) ? (payload as VisualPlanPayload).beats as VisualPlanBeat[] : [];
  const scenes = scriptPayload && typeof scriptPayload === "object" && Array.isArray((scriptPayload as { scenes?: unknown }).scenes) ? (scriptPayload as { scenes: ScriptScene[] }).scenes : [];
  const repairs: string[] = [];
  for (const scene of scenes) {
    if (typeof scene.scene_index !== "number" || typeof scene.narration !== "string") continue;
    const sceneBeats = beats.filter((b)=>b.scene_index===scene.scene_index).sort((a,b)=>Number(a.beat_index??0)-Number(b.beat_index??0));
    if (!sceneBeats.length) continue;
    const chunks = splitApprovedNarration(scene.narration, sceneBeats.length);
    if (chunks.some((chunk)=>chunk.length===0 || chunk.length>600)) continue;
    sceneBeats.forEach((beat,i)=>{ if (beat.narration !== chunks[i]) { beat.narration = chunks[i]!; repairs.push(`scene ${scene.scene_index} beat ${i}`); } });
  }
  return repairs;
}

export function visualDirectorCoverageErrors(payload: unknown, scriptPayload: unknown): string[] {
  repairVisualDirectorNarration(payload, scriptPayload);
  const beats = payload && typeof payload === "object" && Array.isArray((payload as VisualPlanPayload).beats) ? (payload as VisualPlanPayload).beats as VisualPlanBeat[] : [];
  const scenes = scriptPayload && typeof scriptPayload === "object" && Array.isArray((scriptPayload as { scenes?: unknown }).scenes) ? (scriptPayload as { scenes: ScriptScene[] }).scenes : [];
  if (!scenes.length) return ["visual_director cannot prove coverage because the script has no scenes"];
  const errors: string[] = [], scriptIndices = new Set<number>();
  let expectedGlobalId=1;
  for (const scene of scenes) {
    if (typeof scene.scene_index !== "number" || typeof scene.narration !== "string") continue;
    const sceneIndex=scene.scene_index; scriptIndices.add(sceneIndex);
    const sceneBeats=beats.filter((b)=>b.scene_index===sceneIndex).sort((a,b)=>Number(a.beat_index??0)-Number(b.beat_index??0));
    if(!sceneBeats.length){errors.push(`scene ${sceneIndex}: visual plan has no beats`);continue;}
    for(let i=0;i<sceneBeats.length;i++){
      const beat=sceneBeats[i]!;
      if(beat.beat_index!==i) errors.push(`scene ${sceneIndex}: beat_index must be contiguous from 0`);
      const expectedId=`beat_${String(expectedGlobalId).padStart(3,"0")}`;
      if(beat.id!==expectedId) errors.push(`scene ${sceneIndex}: expected global id ${expectedId}, got ${String(beat.id??"missing")}`);
      expectedGlobalId++;
    }
    const reconstructed=sceneBeats.map((b)=>typeof b.narration==="string"?b.narration:"").join("");
    if(reconstructed!==scene.narration) errors.push(`scene ${sceneIndex}: engine-derived beat narration does not exactly reproduce the approved script`);
  }
  const extra=[...new Set(beats.map((b)=>typeof b.scene_index==="number"?b.scene_index:null).filter((v):v is number=>v!==null&&!scriptIndices.has(v)))];
  if(extra.length) errors.push(`visual plan contains scene(s) not present in the approved script: ${extra.join(", ")}`);
  return errors;
}

export function visualDirectorFallbackErrors(payload: unknown): string[] {
  const beats = payload && typeof payload === "object" && Array.isArray((payload as VisualPlanPayload).beats) ? (payload as VisualPlanPayload).beats as QualityBeatLike[] : [];
  const errors:string[]=[];
  for(const beat of beats){
    errors.push(...fallbackContractErrors(beat));
    const scene=beat.asset_brief?.semantic_scene as SemanticScene|undefined;
    const kind=scene&&typeof scene==="object"?String((scene as {kind?:unknown}).kind??""):"";
    if(scene&&kind&&kind!=="kinetic_phrase"&&kind!=="none"){
      const id=typeof beat.id==="string"?beat.id:"beat";
      errors.push(...validateSemanticScene(scene,id));
    }
  }
  return errors;
}
function hard(errors:string[]):string[]{return errors.map(e=>`${HARD_ERROR_PREFIX}${e}`);}

export function agentSemanticValidationErrors(def:AgentDef,payload:unknown,inputs:Record<string,Artifact>):string[]{
  if(def.name==="episode_director") return hard(unsafeDirectionTextPrompts(payload));
  if(def.name==="visual_director") return hard([...visualDirectorCoverageErrors(payload,inputs["script"]?.payload),...visualDirectorFallbackErrors(payload)]);
  if(def.name==="growth_packager") return hard([...continuationBridgeErrors(payload),...validateGrowthPackageReleaseability(payload)]);
  return [];
}
