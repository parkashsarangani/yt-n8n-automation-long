import { llmRoutingConfig } from "./llm-routing.ts";
import { prepareVisionImage } from "./media/vision-image.ts";
import { FREE_VISION_ATTEMPT_TIMEOUT_MS, freeVisionTripped, recordFreeVisionResult } from "./vision-route-health.ts";
import type { CandidateScores, VisualBeat } from "./visual-routing.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 45_000;

export interface QaImage { bytes: Uint8Array; media_type: string }
export interface VisualBeatQaResult {
  scores: CandidateScores;
  reason: string;
  generic_filler: boolean;
  why_failure: boolean;
  repetitive_with_context: boolean;
}
export type VisualBeatFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function dataUri(image: QaImage): string { return `data:${image.media_type};base64,${Buffer.from(image.bytes).toString("base64")}`; }
function score(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function bool(value: unknown): boolean { return value === true; }
interface RequestFrames { candidate: QaImage[]; previous?: QaImage; next?: QaImage }

function imageParts(frames: RequestFrames): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (frames.previous) {
    parts.push({ type: "text", text: "PREVIOUS SELECTED/RENDERED VISUAL:" });
    parts.push({ type: "image_url", image_url: { url: dataUri(frames.previous), detail: "low" } });
  }
  parts.push({ type: "text", text: `CURRENT CANDIDATE/RENDER — ${frames.candidate.length} chronological frame sample(s):` });
  for (const image of frames.candidate) parts.push({ type: "image_url", image_url: { url: dataUri(image), detail: "low" } });
  if (frames.next) {
    parts.push({ type: "text", text: "FOLLOWING SELECTED/RENDERED VISUAL:" });
    parts.push({ type: "image_url", image_url: { url: dataUri(frames.next), detail: "low" } });
  }
  return parts;
}

async function request(
  endpoint: { baseUrl: string; apiKey: string; model: string; label: string; timeoutMs?: number },
  frames: RequestFrames,
  beat: VisualBeat,
  fetchImpl: VisualBeatFetch,
): Promise<VisualBeatQaResult | null> {
  if (frames.candidate.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs ?? TIMEOUT_MS);
  const instruction = [
    "Judge the CURRENT visual as the exact pixels shown under one narration beat in a YouTube explainer/story.",
    "Multiple CURRENT images are chronological samples from one beat. PREVIOUS/FOLLOWING images are context only: use them for identity/location continuity and actual visual repetition.",
    `NARRATION: ${beat.narration.slice(0,500)}`,
    `PREVIOUS NARRATIVE CONTEXT: ${beat.context.previous.slice(0,350) || "none"}`,
    `NEXT NARRATIVE CONTEXT: ${beat.context.next.slice(0,350) || "none"}`,
    `VIEWER MUST TAKE AWAY: ${beat.visual_contract.viewer_takeaway.slice(0,300)}`,
    `MUST VISIBLY INCLUDE: ${beat.visual_contract.required.join("; ").slice(0,700)}`,
    `REQUIRED ACTION/STATE: ${beat.visual_contract.required_action.slice(0,300) || "none"}`,
    `FORBIDDEN/MISLEADING: ${beat.visual_contract.forbidden.join("; ").slice(0,550) || "none"}`,
    `EMOTIONAL INTENT: ${beat.intent.emotion}`,
    `COMPOSITION INTENT: ${beat.retention.composition}`,
    `CONTINUITY GROUP: ${beat.continuity.group || "none"}; recurring entities: ${beat.continuity.entities.join(", ") || "none"}`,
    "semantic_match=immediate specific communication of required concepts, not topical association. action_match=required physical action/state; 1.0 if none. visual_interest=specificity, composition, legibility, useful motion/information and attention value. continuity=recurring identity/location/object preservation against adjacent visuals; 1.0 if none required.",
    "generic_filler=true if the current visual could accompany many unrelated sentences. why_failure=true if a normal viewer would reasonably ask 'why am I seeing this?'. repetitive_with_context=true only when the current visual repeats the recent visual grammar/shot/composition so strongly that it feels monotonous rather than purposeful continuity.",
    "Respond ONLY JSON: {\"semantic_match\":0.0,\"action_match\":0.0,\"visual_interest\":0.0,\"continuity\":0.0,\"generic_filler\":false,\"why_failure\":false,\"repetitive_with_context\":false,\"reason\":\"one concrete sentence\"}",
  ].join("\n");
  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model:endpoint.model, messages:[{role:"user",content:[{type:"text",text:instruction},...imageParts(frames)]}], max_completion_tokens:650, response_format:{type:"json_object"} }),
      signal: controller.signal,
    });
    if (!res.ok) { console.warn(`[visual-beat-qa] ${endpoint.label} failed: HTTP ${res.status}`); return null; }
    const payload=await res.json() as {choices?:Array<{message?:{content?:string}}>}; const raw=payload.choices?.[0]?.message?.content; if(typeof raw!=="string") return null;
    const parsed=JSON.parse(raw) as Record<string,unknown>;
    return { scores:{semantic_match:score(parsed["semantic_match"]),action_match:score(parsed["action_match"]),visual_interest:score(parsed["visual_interest"]),continuity:score(parsed["continuity"])}, generic_filler:bool(parsed["generic_filler"]), why_failure:bool(parsed["why_failure"]), repetitive_with_context:bool(parsed["repetitive_with_context"]), reason:typeof parsed["reason"]==="string"?parsed["reason"].slice(0,500):"" };
  } catch(err){ console.warn(`[visual-beat-qa] ${endpoint.label} failed: ${err instanceof Error?err.message:String(err)}`); return null; }
  finally{ clearTimeout(timer); }
}

async function routedRequest(raw:RequestFrames,beat:VisualBeat,fetchImpl:VisualBeatFetch):Promise<VisualBeatQaResult|null>{
  const frames:RequestFrames={
    candidate:await Promise.all(raw.candidate.map(prepareVisionImage)),
    ...(raw.previous?{previous:await prepareVisionImage(raw.previous)}:{}),
    ...(raw.next?{next:await prepareVisionImage(raw.next)}:{}),
  };
  const routing=llmRoutingConfig();
  if(routing.mode==="freellmapi"&&routing.apiKey&&!freeVisionTripped()){ const free=await request({baseUrl:routing.baseUrl,apiKey:routing.apiKey,model:routing.visionModel,label:"freellmapi",timeoutMs:FREE_VISION_ATTEMPT_TIMEOUT_MS},frames,beat,fetchImpl); recordFreeVisionResult(free!==null); if(free)return free; if(!routing.failOpenToDirect)return null; }
  const apiKey=process.env["OPENAI_API_KEY"]?.trim(); if(!apiKey)return null;
  return request({baseUrl:(process.env["OPENAI_BASE_URL"]??DEFAULT_BASE_URL).replace(/\/$/,""),apiKey,model:process.env["OPENAI_IMAGE_QA_MODEL"]??process.env["OPENAI_MODEL"]??"gpt-5.6-luna",label:"direct-openai"},frames,beat,fetchImpl);
}

export async function scoreVisualBeatImage(image:QaImage,beat:VisualBeat,fetchImpl:VisualBeatFetch=fetch as unknown as VisualBeatFetch,adjacent:{previous?:QaImage;next?:QaImage}={}):Promise<VisualBeatQaResult|null>{ return routedRequest({candidate:[image],...adjacent},beat,fetchImpl); }
export async function scoreVisualBeatFrames(frames:QaImage[],beat:VisualBeat,adjacent:{previous?:QaImage;next?:QaImage}={},fetchImpl:VisualBeatFetch=fetch as unknown as VisualBeatFetch):Promise<VisualBeatQaResult|null>{ return routedRequest({candidate:frames.slice(0,6),...adjacent},beat,fetchImpl); }
