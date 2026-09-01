import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { SEMANTIC_REPRESENTATION_CONTRACT, semanticBlueprintFitsMode } from "../semantic-representation.ts";

// Deterministic half of the storyboard review gate. Semantic-plan structural
// invariants are facts rather than taste, so they are enforced here in
// addition to the critic/reviser loop.

const RELATIONSHIP_PRIMITIVES = new Set([
  "network", "hierarchy", "one-to-many", "many-to-one", "cause-chain",
]);

interface ReviewScene {
  scene_index?: unknown;
  verdict?: unknown;
  failure_mode?: unknown;
}

type Scene = Record<string, unknown>;

function scenesOf(payload: unknown): Scene[] {
  const record = payload && typeof payload === "object" ? payload as { scenes?: unknown } : {};
  return Array.isArray(record.scenes) ? record.scenes.filter((scene): scene is Scene => !!scene && typeof scene === "object") : [];
}

function byIndex(scenes: Scene[]): Map<number, Scene> {
  const map = new Map<number, Scene>();
  for (const scene of scenes) {
    const index = scene["scene_index"];
    if (typeof index === "number" && Number.isInteger(index)) map.set(index, scene);
  }
  return map;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function flaggedSceneIndices(review: unknown): number[] {
  const record = review && typeof review === "object" ? review as { scenes?: unknown } : {};
  const scenes = Array.isArray(record.scenes) ? record.scenes as ReviewScene[] : [];
  const flagged: number[] = [];
  for (const scene of scenes) {
    if (typeof scene?.scene_index !== "number" || !Number.isInteger(scene.scene_index)) continue;
    const weak = scene.verdict === "weak";
    const defective = typeof scene.failure_mode === "string" && scene.failure_mode !== "none" && scene.failure_mode !== "";
    if (weak || defective) flagged.push(scene.scene_index);
  }
  return [...new Set(flagged)].sort((a, b) => a - b);
}

function validateSemanticScene(scene: Scene, index: number, isOpening: boolean, failures: string[]): boolean {
  const mode = scene["representation_mode"];
  if (typeof mode !== "string") return false; // legacy plan: handled below.
  const blueprint = scene["scene_blueprint"];
  const claim = scene["visual_claim"];
  const actions = Array.isArray(scene["visual_actions"]) ? scene["visual_actions"] : [];

  const allowed = SEMANTIC_REPRESENTATION_CONTRACT[mode as keyof typeof SEMANTIC_REPRESENTATION_CONTRACT];
  if (!allowed) {
    failures.push(`scene ${index} has unsupported representation_mode ${JSON.stringify(mode)}`);
    return true;
  }
  if (typeof blueprint !== "string" || !semanticBlueprintFitsMode(mode, blueprint)) {
    failures.push(`scene ${index} representation_mode ${mode} cannot use scene_blueprint ${JSON.stringify(blueprint)}`);
  }
  if (typeof claim !== "string" || claim.trim().length < 4) {
    failures.push(`scene ${index} has no usable visual_claim`);
  }

  // The opening scene is the hook: the single scene most responsible for
  // whether a viewer keeps watching. kinetic-text/animated-statement is the
  // deliberate "nothing concrete was authored" fallback (see the module
  // comment at the top of this file and semantic-visual-assets.ts's
  // semanticPayload) -- correct as a rare escape hatch deep in an episode,
  // but the opening scene falling back to plain animated text is a content
  // defect, not a schema violation, so it needs its own explicit check
  // rather than silently passing every other structural rule kinetic-text
  // scenes are allowed to satisfy.
  if (isOpening && mode === "kinetic-text") {
    failures.push(`scene ${index} is the opening scene and must not use the kinetic-text/animated-statement fallback; author a concrete/domain/quantitative/spatial representation for the hook`);
  }

  if (mode === "kinetic-text") {
    if (blueprint !== "animated-statement") failures.push(`scene ${index} kinetic-text must use animated-statement`);
    if (actions.length > 0) failures.push(`scene ${index} animated-statement must not carry semantic visual_actions`);
  } else if (actions.length === 0) {
    failures.push(`scene ${index} semantic representation ${mode}/${String(blueprint)} has no visual_actions; unsupported scenes must explicitly use animated-statement instead of falling into generic geometry`);
  }

  for (const [actionIndex, action] of actions.entries()) {
    if (!action || typeof action !== "object") {
      failures.push(`scene ${index} visual_actions[${actionIndex}] is not an object`);
      continue;
    }
    const record = action as Record<string, unknown>;
    if (typeof record["actor"] !== "string" || !record["actor"].trim()) failures.push(`scene ${index} visual_actions[${actionIndex}] has no actor`);
    if (typeof record["action"] !== "string" || !record["action"].trim()) failures.push(`scene ${index} visual_actions[${actionIndex}] has no action`);
    if (typeof record["anchor_phrase"] !== "string" || !record["anchor_phrase"].trim()) failures.push(`scene ${index} visual_actions[${actionIndex}] has no anchor_phrase`);
  }
  return true;
}

export function assessPlanRevision(original: unknown, revised: unknown, review: unknown): { failures: string[] } {
  const failures: string[] = [];
  const originalScenes = byIndex(scenesOf(original));
  const revisedScenes = scenesOf(revised);
  const revisedByIndex = byIndex(revisedScenes);

  if (revisedScenes.length === 0) return { failures: ["revised plan has no scenes"] };
  if (revisedScenes.length !== scenesOf(original).length) {
    failures.push(`revision changed the scene count (${scenesOf(original).length} -> ${revisedScenes.length}); every script scene needs exactly one plan scene`);
  }

  for (const index of flaggedSceneIndices(review)) {
    const before = originalScenes.get(index);
    const after = revisedByIndex.get(index);
    if (!after) {
      failures.push(`scene ${index} was flagged for revision but is missing from the revision`);
      continue;
    }
    if (before && stableJson(before) === stableJson(after)) failures.push(`scene ${index} was flagged for revision but came back byte-identical`);
  }

  let legacyRelationshipScenes = 0;
  let legacyUnauthored = 0;

  // The opening scene is whichever scene has the LOWEST scene_index, matching
  // the convention already used elsewhere (cartoon-scenes-v16.ts's
  // openingIndex) -- not a literal scene_index of 0, since a resumed or
  // partially-renumbered plan is not guaranteed to start there.
  const sceneIndices = revisedScenes
    .map((scene) => scene["scene_index"])
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value));
  const openingIndex = sceneIndices.length ? Math.min(...sceneIndices) : undefined;

  for (const scene of revisedScenes) {
    const index = typeof scene["scene_index"] === "number" ? scene["scene_index"] : -1;
    const elements = Array.isArray(scene["model_elements"]) ? scene["model_elements"] : [];
    const relations = Array.isArray(scene["model_relations"]) ? scene["model_relations"] : [];

    for (const relation of relations) {
      if (!relation || typeof relation !== "object") continue;
      const record = relation as Record<string, unknown>;
      for (const end of ["from_element", "to_element"] as const) {
        const value = record[end];
        if (typeof value === "number" && Number.isInteger(value) && value >= elements.length) {
          failures.push(`scene ${index} relation ${end}=${value} points past its ${elements.length} model_elements`);
        }
      }
    }

    // New semantic plans never depend on a fixed-topology diagram fallback.
    // The legacy majority rule remains only for resumed pre-1.6 artifacts.
    if (validateSemanticScene(scene, index, index === openingIndex, failures)) continue;

    const primitive = typeof scene["visual_primitive"] === "string" ? scene["visual_primitive"] : "";
    if (!RELATIONSHIP_PRIMITIVES.has(primitive)) continue;
    legacyRelationshipScenes += 1;
    if (relations.length === 0) legacyUnauthored += 1;
  }

  if (legacyRelationshipScenes > 0 && legacyUnauthored * 2 > legacyRelationshipScenes) {
    failures.push(`${legacyUnauthored} of ${legacyRelationshipScenes} relationship-primitive scenes authored no model_relations, so most of this legacy episode's diagrams would render the fixed fallback topology`);
  }

  return { failures };
}

export function makeExplanationPlanReleaseWorker(): WorkerDef {
  return {
    name: "explanation_plan_release",
    kind: "worker",
    version: "3",
    consumes: [
      { schema_id: "explanation_plan", range: "^1", as: "original" },
      { schema_id: "explanation_plan", range: "^1", as: "revised" },
      { schema_id: "explanation_plan_review", range: "^1", as: "review" },
    ],
    produces: "explanation_plan",
    produces_version: "1.6.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const original = inputs["original"]?.payload;
      const revised = inputs["revised"]?.payload;
      const { failures } = assessPlanRevision(original, revised, inputs["review"]?.payload);

      if (failures.length > 0) {
        throw new Error(`explanation plan release blocked (attempt ${ctx.attemptNumber}): ${failures.join("; ")}`);
      }
      return { payload: revised };
    },
  };
}
