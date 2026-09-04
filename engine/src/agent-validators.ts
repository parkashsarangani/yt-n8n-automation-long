/**
 * Per-agent semantic validation hook (RFC 0003).
 *
 * runner.ts calls agentSemanticValidationErrors after every agent attempt so
 * a mistake the schema itself can't express (a valid-but-wrong combination of
 * otherwise-legal field values) still costs a retry with actionable feedback
 * instead of shipping a broken artifact. A returned error prefixed with
 * HARD_ERROR_PREFIX additionally blocks accept-on-last-attempt: the payload
 * is not just weak, it is guaranteed to break a downstream deterministic
 * worker that has no retry of its own.
 */
import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";

export const HARD_ERROR_PREFIX = "HARD:";

export function hasHardSemanticError(errors: string[]): boolean {
  return errors.some((error) => error.startsWith(HARD_ERROR_PREFIX));
}

type DirectionShot = { image_prompt?: unknown };
type DirectionScene = { scene_index?: unknown; shots?: unknown };
type DirectionPayload = { scenes?: unknown };
type GrowthPayload = { next_video_bridge?: unknown };

const TEXT_BEARING_SURFACE = /\b(document|paper|chart|form|letter|note|sign|poster|screen|monitor|phone|tablet|directory|contract|badge|name\s*tag|label|menu|receipt|ticket|book|newspaper|clipboard|whiteboard|blackboard|spreadsheet|list|certificate)\b/i;
const READABLE_TEXT_SIGNAL = /\b(readable|legible|printed|written|labeled|labelled|names?|words?|text|writing|letters?|numbers?|dates?|signature|address|headline|title|caption|prices?|scores?|rows?|columns?)\b/i;
const SAFE_TEXT_FRAMING = /\b(face[- ]?down|turned away|back(?: side)? facing|closed|folded|blank|unreadable|illegible|blurred|out[- ]?of[- ]?focus|distant|cropped|obscured|covered|screen off|dark screen|no visible (?:text|writing)|without readable (?:text|writing))\b/i;
const GENERIC_ENGAGEMENT = /\b(like|subscribe|follow|comment|share|hit (?:the )?bell|notification bell)\b/i;
const GENERIC_CONTINUATION = /\b(stay tuned|more like this|what happens next|watch (?:the )?(?:next|another) (?:video|episode)|check out (?:the )?(?:next|another) (?:video|episode))\b/i;

export function unsafeDirectionTextPrompts(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const scenes = Array.isArray((payload as DirectionPayload).scenes)
    ? (payload as DirectionPayload).scenes as DirectionScene[]
    : [];
  const errors: string[] = [];
  for (const scene of scenes) {
    const shots = Array.isArray(scene?.shots) ? scene.shots as DirectionShot[] : [];
    shots.forEach((shot, shotIndex) => {
      const prompt = typeof shot?.image_prompt === "string" ? shot.image_prompt.trim() : "";
      if (!prompt) return;
      if (TEXT_BEARING_SURFACE.test(prompt) && READABLE_TEXT_SIGNAL.test(prompt) && !SAFE_TEXT_FRAMING.test(prompt)) {
        const sceneIndex = typeof scene.scene_index === "number" ? scene.scene_index : "?";
        errors.push(
          `scene ${sceneIndex} shot ${shotIndex} asks a text-bearing object to carry readable writing; ` +
          `depict the physical object/action with its face blank, closed, face-down, turned away, distant, cropped, or otherwise unreadable`,
        );
      }
    });
  }
  return errors;
}

export function continuationBridgeErrors(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const bridge = typeof (payload as GrowthPayload).next_video_bridge === "string"
    ? ((payload as GrowthPayload).next_video_bridge as string).trim()
    : "";
  if (!bridge) return [];
  const errors: string[] = [];
  if (GENERIC_ENGAGEMENT.test(bridge)) {
    errors.push("next_video_bridge must continue the viewing session, not ask for likes/subscriptions/follows/comments/shares");
  }
  if (GENERIC_CONTINUATION.test(bridge)) {
    errors.push("next_video_bridge must name or imply a specific adjacent story/question instead of generically saying to watch another video");
  }
  return errors;
}

export function agentSemanticValidationErrors(
  def: AgentDef,
  payload: unknown,
  _inputs: Record<string, Artifact>,
): string[] {
  if (def.name === "episode_director") return unsafeDirectionTextPrompts(payload);
  if (def.name === "growth_packager") return continuationBridgeErrors(payload);
  return [];
}
