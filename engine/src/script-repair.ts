export interface OutroFlagRepair {
  path: string;
  from: string;
  to: string;
}

// Real production evidence: three separate real runs (a 45s soda-can
// episode, a 30s spoon episode, twice) burned all 3 dialogue_script_writer
// attempts on the exact same mistake -- the writer correctly places one real
// outro/CTA scene, with real content, in the correct final position, and
// simply omits the one-off `is_outro: true` field (the only field that
// breaks the otherwise-uniform six-field scene shape, easy to drop at the
// tail of a long generation). The content is never wrong; only the flag is
// missing. Spending a full regeneration on a one-field, unambiguously
// detectable omission is exactly the class of mistake runner.ts's other
// repair functions (repairEnumValues, repairMotionCompatibility,
// repairOverlongLabels) already exist to fix deterministically instead of
// retrying.
//
// Deliberately conservative: only repairs the single unambiguous case (one
// scene whose point clearly marks it as the outro, and it is already the
// literal last scene). Anything else -- zero candidates, more than one, or
// a candidate that isn't last -- is a real structural defect (the writer
// split the outro across two scenes, or misplaced it) that the semantic
// gate in agent-validators.ts must still catch and report with retry
// feedback, not something this silently papers over.
export function repairMissingOutroFlag(payload: unknown): { data: unknown; repairs: OutroFlagRepair[] } {
  if (!payload || typeof payload !== "object") return { data: payload, repairs: [] };
  const record = payload as Record<string, unknown>;
  const scenes = record["scenes"];
  if (!Array.isArray(scenes) || scenes.length === 0) return { data: payload, repairs: [] };

  const alreadyFlagged = scenes.some(
    (scene) => scene && typeof scene === "object" && (scene as Record<string, unknown>)["is_outro"] === true,
  );
  if (alreadyFlagged) return { data: payload, repairs: [] };

  const outroLikeIndexes = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => {
      if (!scene || typeof scene !== "object") return false;
      const point = (scene as Record<string, unknown>)["point"];
      return typeof point === "string" && /function\s*=\s*outro\b/i.test(point);
    })
    .map(({ index }) => index);

  if (outroLikeIndexes.length !== 1) return { data: payload, repairs: [] };
  const outroIndex = outroLikeIndexes[0]!;
  if (outroIndex !== scenes.length - 1) return { data: payload, repairs: [] };

  const repairedScenes = scenes.map((scene, index) =>
    index === outroIndex ? { ...(scene as Record<string, unknown>), is_outro: true } : scene,
  );
  return {
    data: { ...record, scenes: repairedScenes },
    repairs: [{ path: `scenes[${outroIndex}].is_outro`, from: "undefined", to: "true" }],
  };
}
