/** Per-agent semantic validation hook. */
import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";
import { validateGrowthPackageReleaseability } from "./growth-package-contract.ts";

export const HARD_ERROR_PREFIX = "HARD:";
export function hasHardSemanticError(errors: string[]): boolean {
  return errors.some((error) => error.startsWith(HARD_ERROR_PREFIX));
}

type GrowthPayload = { next_video_bridge?: unknown };
const GENERIC_ENGAGEMENT = /\b(like|subscribe|follow|comment|share|hit (?:the )?bell|notification bell)\b/i;
const GENERIC_CONTINUATION = /\b(stay tuned|more like this|what happens next|watch (?:the )?(?:next|another) (?:video|episode)|check out (?:the )?(?:next|another) (?:video|episode))\b/i;

export function continuationBridgeErrors(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as GrowthPayload).next_video_bridge;
  const bridge = typeof raw === "string" ? raw.trim() : "";
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

function hard(errors: string[]): string[] {
  return errors.map((error) => `${HARD_ERROR_PREFIX}${error}`);
}

export function agentSemanticValidationErrors(
  def: AgentDef,
  payload: unknown,
  _inputs: Record<string, Artifact>,
): string[] {
  if (def.name === "growth_packager") {
    return hard([...continuationBridgeErrors(payload), ...validateGrowthPackageReleaseability(payload)]);
  }
  return [];
}
