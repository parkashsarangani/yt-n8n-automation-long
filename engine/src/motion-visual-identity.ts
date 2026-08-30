export const MOTION_STYLE_ID = "motion-editorial-v1";
export const MOTION_PALETTE_ID = "motion-semantic-v1";
export const MOTION_BG = "#08101E";
export const MOTION_PAPER = "#F7F4EA";

/**
 * Canonical deterministic entity colours used by the Remotion
 * MotionDesignSystem.EntityMark renderer. Engine-side AI prompts consume the
 * same contract so a cut from motion graphics into generated imagery preserves
 * an entity's visual identity rather than merely its wording.
 *
 * Shape used to be part of this contract: the renderer hashed an entity id
 * into one of six polygons and the AI prompt asked for the matching
 * silhouette, so both sides drew the same symbol. That symbol was arbitrary --
 * "vacuum gap" became a plus, "heat loss" a hexagon -- and watch feedback
 * called it out directly. EntityMark now renders an entity's own words when
 * no real icon resolves, so there is no shape on the motion-graphics side to
 * match; asking the image model for a silhouette would create a mismatch
 * rather than continuity. Colour still carries identity on both sides.
 *
 * The Remotion renderer lives in a separate Docker build context, so CI pins
 * that implementation to this contract in motion-visual-identity-contract.test.
 */
export const MOTION_ENTITY_COLORS = [
  "#FFD166",
  "#65C7F7",
  "#7DE2A8",
  "#B794F4",
  "#FF7D7D",
  "#5DE0C6",
] as const;

export interface MotionEntityVisualToken {
  entity_id: string;
  color: typeof MOTION_ENTITY_COLORS[number];
}

export function motionEntityHash(value: string): number {
  return Array.from(value).reduce(
    (hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0),
    2166136261,
  );
}

export function motionEntityVisualTokens(ids: string[]): MotionEntityVisualToken[] {
  return ids.map((entity_id) => {
    const hash = motionEntityHash(entity_id || "entity");
    return {
      entity_id,
      color: MOTION_ENTITY_COLORS[hash % MOTION_ENTITY_COLORS.length]!,
    };
  });
}
