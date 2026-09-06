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
  /** Optional diagnostics: actual implementation always returns them, but optionality preserves compatibility with older typed fixtures. */
  requirements_visible?: boolean;
  action_evidence?: boolean;
  identity_continuity_evidence?: boolean;
  composition_failure?: boolean;
  garbled_text?: boolean;
  implausible_object_scale?: boolean;
  environment_mismatch?: boolean;
}
export type VisualBeatFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function dataUri(image: QaImage): string { return `data:${image.media_type};base64,${Buffer.from(image.bytes).toString("base64")}`; }
function score(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function bool(value: unknown): boolean { return value === true; }
function boolOr(value: unknown, fallback: boolean): boolean { return typeof value === "boolean" ? value : fallback; }
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

function evidenceAdjustedResult(parsed: Record<string, unknown>, beat: VisualBeat): VisualBeatQaResult {
  const semanticRaw = score(parsed["semantic_match"]);
  const actionRaw = score(parsed["action_match"]);
  const interestRaw = score(parsed["visual_interest"]);
  const continuityRaw = score(parsed["continuity"]);
  const actionRequired = beat.visual_contract.required_action.trim().length > 0;
  const identityRequired = beat.continuity.group.trim().length > 0 && beat.continuity.entities.length > 0;

  // Explicit evidence fields prevent a high scalar score from laundering absent
  // pixels. Score-derived defaults only preserve compatibility when a model
  // accidentally omits a new JSON key.
  const requirementsVisible = boolOr(parsed["requirements_visible"], semanticRaw >= 0.90);
  const actionEvidence = actionRequired ? boolOr(parsed["action_evidence"], actionRaw >= 0.70) : true;
  const identityContinuityEvidence = identityRequired ? boolOr(parsed["identity_continuity_evidence"], continuityRaw >= 0.70) : true;
  const compositionFailure = bool(parsed["composition_failure"]);
  const garbledText = bool(parsed["garbled_text"]);
  const implausibleObjectScale = bool(parsed["implausible_object_scale"]);
  const environmentMismatch = bool(parsed["environment_mismatch"]);

  // Run #9 exposed a concrete false positive: generic station footage received
  // ~0.90 action before final rendered QA correctly found no visible phone-send
  // action. Observable-evidence booleans are therefore authoritative backstops.
  const semanticMatch = requirementsVisible ? semanticRaw : Math.min(semanticRaw, 0.40);
  const actionMatch = actionRequired && !actionEvidence ? Math.min(actionRaw, 0.20) : actionRaw;
  const continuity = identityRequired && !identityContinuityEvidence ? Math.min(continuityRaw, 0.20) : continuityRaw;

  const genericFiller = bool(parsed["generic_filler"]) || (actionRequired && !actionEvidence);
  const whyFailure = bool(parsed["why_failure"])
    || !requirementsVisible
    || (identityRequired && !identityContinuityEvidence)
    || compositionFailure
    || garbledText
    || implausibleObjectScale
    || environmentMismatch;

  const rawReason = typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 500) : "";
  const enforced: string[] = [];
  if (!requirementsVisible) enforced.push("required visual evidence missing");
  if (actionRequired && !actionEvidence) enforced.push("required action not visibly evidenced");
  if (identityRequired && !identityContinuityEvidence) enforced.push("recurring entity identity mismatch");
  if (compositionFailure) enforced.push("composition/framing failure");
  if (garbledText) enforced.push("garbled AI typography");
  if (implausibleObjectScale) enforced.push("implausible object scale");
  if (environmentMismatch) enforced.push("environment continuity mismatch");
  const reason = [rawReason, enforced.length ? `Gate: ${enforced.join(", ")}.` : ""].filter(Boolean).join(" ").slice(0, 700);

  return {
    scores: { semantic_match: semanticMatch, action_match: actionMatch, visual_interest: interestRaw, continuity },
    generic_filler: genericFiller,
    why_failure: whyFailure,
    repetitive_with_context: bool(parsed["repetitive_with_context"]),
    requirements_visible: requirementsVisible,
    action_evidence: actionEvidence,
    identity_continuity_evidence: identityContinuityEvidence,
    composition_failure: compositionFailure,
    garbled_text: garbledText,
    implausible_object_scale: implausibleObjectScale,
    environment_mismatch: environmentMismatch,
    reason,
  };
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
    "Evidence rules are strict. requirements_visible=true ONLY when every important MUST VISIBLY INCLUDE requirement is actually present in the CURRENT pixels; topical association is not evidence.",
    "If REQUIRED ACTION/STATE is non-empty, action_evidence=true ONLY when the sampled CURRENT frames visibly show that subject performing/entering/completing the action or state. Never infer an action because the location, clothing, or object makes it plausible. For video, use visible chronological progression across the CURRENT samples.",
    "If recurring entity IDs are present, identity_continuity_evidence=true ONLY when the same recurring person/object is visually consistent with adjacent context: face/body silhouette, age, hair, clothing, distinguishing attributes and environment when visible. A different actor/wardrobe is a failure, even if the narration topic matches.",
    "composition_failure=true for unusable framing such as headless/accidental crop, split/composite imbalance, key subject obscured, or a prop dominating the frame without explanatory need. implausible_object_scale=true when a phone/prop/object is visibly oversized or physically implausible. environment_mismatch=true when a recurring location changes materially without narrative reason.",
    "garbled_text=true ONLY for obvious pseudo-writing, malformed letters, unreadable AI UI/signage/handwriting, or corrupted typography that materially harms the frame. Legitimate readable text, numbers, clock faces, dates, map labels, equations and required numeric labels are allowed and MUST NOT be flagged merely because text is visible.",
    "semantic_match=immediate specific communication of required concepts, not topical association. action_match=required physical action/state; 1.0 if none. visual_interest=specificity, composition, legibility, useful motion/information and attention value. continuity=recurring identity/location/object preservation against adjacent visuals; 1.0 if none required.",
    "generic_filler=true if the current visual could accompany many unrelated sentences OR if a required real-world action is replaced by generic location/crowd footage. why_failure=true if a normal viewer would reasonably ask 'why am I seeing this?' or if the concept is technically present but framing/identity/text artifacts make the shot unusable.",
    "repetitive_with_context=true only when the current visual repeats the recent visual grammar/shot/composition so strongly that it feels monotonous rather than purposeful continuity.",
    "Respond ONLY JSON: {\"semantic_match\":0.0,\"action_match\":0.0,\"visual_interest\":0.0,\"continuity\":0.0,\"generic_filler\":false,\"why_failure\":false,\"repetitive_with_context\":false,\"requirements_visible\":true,\"action_evidence\":true,\"identity_continuity_evidence\":true,\"composition_failure\":false,\"garbled_text\":false,\"implausible_object_scale\":false,\"environment_mismatch\":false,\"reason\":\"one concrete sentence\"}",
  ].join("\n");
  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model:endpoint.model, messages:[{role:"user",content:[{type:"text",text:instruction},...imageParts(frames)]}], max_completion_tokens:850, response_format:{type:"json_object"} }),
      signal: controller.signal,
    });
    if (!res.ok) { console.warn(`[visual-beat-qa] ${endpoint.label} failed: HTTP ${res.status}`); return null; }
    const payload=await res.json() as {choices?:Array<{message?:{content?:string}}>}; const raw=payload.choices?.[0]?.message?.content; if(typeof raw!=="string") return null;
    const parsed=JSON.parse(raw) as Record<string,unknown>;
    return evidenceAdjustedResult(parsed, beat);
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
