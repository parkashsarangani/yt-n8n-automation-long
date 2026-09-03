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
 *
 * Empty today: the agents this held checks for (dialogue_script_writer,
 * cartoon_visual_planner, explanation_visual_planner and their editors/
 * revisers) were retired with the character pipeline (RFC 0008). Add a case
 * here keyed on `def.name` the next time an agent's output needs this kind
 * of cross-field check that a JSON Schema can't express.
 */
import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";

export const HARD_ERROR_PREFIX = "HARD:";

export function hasHardSemanticError(errors: string[]): boolean {
  return errors.some((error) => error.startsWith(HARD_ERROR_PREFIX));
}

export function agentSemanticValidationErrors(
  _def: AgentDef,
  _payload: unknown,
  _inputs: Record<string, Artifact>,
): string[] {
  return [];
}
