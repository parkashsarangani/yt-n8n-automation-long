/** Per-agent semantic validation hook. */
import type { AgentDef } from "./runner.ts";
import { socialSeriesScriptErrors } from "./social-series.ts";
import {presentationErrors} from "./episode-presentation.ts";
import type { Artifact } from "./artifact.ts";
import { validateGrowthPackageReleaseability } from "./growth-package-contract.ts";

export const HARD_ERROR_PREFIX = "HARD:";
export function hasHardSemanticError(errors: string[]): boolean {
  return errors.some((error) => error.startsWith(HARD_ERROR_PREFIX));
}

type GrowthPayload = { next_video_bridge?: unknown };
const GENERIC_ENGAGEMENT = /\b(like|subscribe|follow|comment|share|hit (?:the )?bell|notification bell)\b/i;
const GENERIC_CONTINUATION = /\b(stay tuned|more like this|what happens next|watch (?:the )?(?:next|another) (?:video|episode)|check out (?:the )?(?:next|another) (?:video|episode))\b/i;
// Production incident: next_video_bridge becomes the script's outro narration
// verbatim (narration_script_writer copies story.outro_line, which equals this
// field, word for word), so the free/low-effort growth_packager model kept
// reaching for this exact recap-then-pivot template ("Now that you've learned
// X, let's explore Y") across unrelated episodes/topics. watchability_critic
// flagged it as an unnatural bridge every time, capping otherwise-strong
// scripts (0.84 raw average) at the release floor. Catch it here rather than
// hoping the prompt alone holds.
const GENERIC_RECAP_BRIDGE = /\b(now that you(?:'ve| have)? (?:learned|discovered|seen)|in this (?:video|episode),? you(?:'ve| have)? (?:learned|seen|discovered))\b/i;

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
  if (GENERIC_RECAP_BRIDGE.test(bridge)) {
    errors.push("next_video_bridge must not open with a recap-then-pivot template like 'now that you've learned X, let's explore Y' -- state the next episode's concrete stakes directly instead of summarizing this one first");
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
  const intent = _inputs.intent?.payload as { series?: unknown; niche?: string } | undefined;
  if (def.name === "narration_script_writer" && (intent?.series || intent?.niche === "practical-social-intelligence")) {
    return hard([...socialSeriesScriptErrors(payload), ...(def.produces_version === "1.1.0" ? presentationErrors(payload) : [])]);
  }
  if (def.name === "growth_packager") {
    return hard([...continuationBridgeErrors(payload), ...validateGrowthPackageReleaseability(payload)]);
  }
  return [];
}
