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

    // character-room drops the diagram and stages both characters full-screen
    // in a real room (see cartoon-scenes-v16.ts's applyExplanationFormat,
    // which passes these scenes through to the cinematic-puppet compiler
    // unchanged instead of building a semantic/diagram payload for them).
    // The schema already forces character_cut_in to "both" for this mode via
    // its own conditional; this is the plain-language failure a JSON Schema
    // const mismatch doesn't produce, for the same invariant.
    if (scene["composition_mode"] === "character-room" && scene["character_cut_in"] !== "both") {
      failures.push(`scene ${index} uses composition_mode "character-room" but character_cut_in is ${JSON.stringify(scene["character_cut_in"])}; character-room scenes must show both characters`);
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

  // Episode-level blueprint variety. Real production evidence (run_05ab92ef,
  // a figure-skater episode): 37 of 44 scenes (84%) used before-after-object
  // -- two paired boxes with a before/after label -- because each one
  // honestly fit the individual scene in isolation, which is exactly what
  // the per-scene checks above verify. Nothing checked the EPISODE as a
  // whole, so a viewer saw the identical two-box shape for nearly the entire
  // runtime. Prompt guidance alone has already proven insufficient for this
  // class of mistake this session (see the outro-scene checks above); this
  // is the deterministic backstop.
  const blueprintByScene = [...revisedScenes]
    .sort((a, b) => (typeof a["scene_index"] === "number" ? a["scene_index"] as number : 0) - (typeof b["scene_index"] === "number" ? b["scene_index"] as number : 0))
    .map((scene) => (typeof scene["scene_blueprint"] === "string" ? scene["scene_blueprint"] : undefined))
    .filter((value): value is string => value !== undefined);

  const beforeAfterCount = blueprintByScene.filter((value) => value === "before-after-object").length;
  if (beforeAfterCount > 1) {
    failures.push(`before-after-object is used ${beforeAfterCount} times; it may be used at most once per episode -- the identical two-box shape repeated reads as generic filler, not a distinct explanation each time`);
  }

  if (blueprintByScene.length >= 10) {
    const counts = new Map<string, number>();
    for (const value of blueprintByScene) counts.set(value, (counts.get(value) ?? 0) + 1);
    for (const [blueprint, count] of counts) {
      if (count * 2 > blueprintByScene.length) {
        failures.push(`scene_blueprint "${blueprint}" is used in ${count}/${blueprintByScene.length} scenes; no single blueprint may cover more than half the episode`);
      }
    }
  }

  let run = 1;
  for (let i = 1; i < blueprintByScene.length; i++) {
    run = blueprintByScene[i] === blueprintByScene[i - 1] ? run + 1 : 1;
    if (run > 3) {
      failures.push(`scene_blueprint "${blueprintByScene[i]}" repeats identically for more than 3 consecutive scenes (ending at scene position ${i})`);
      break;
    }
  }

  // Character reappearance floor. Real production evidence (run_cb0de4ec, a
  // 17-scene episode): characters appeared only in the opening hook and the
  // closing recap/outro -- all 14 scenes between them ran character-free,
  // which is well under the existing <=35% ceiling but reads as narration
  // over a slideshow, not two hosts walking the viewer through an idea. The
  // <=35% rule bounds character OVERuse; nothing bounded character absence
  // until now.
  const orderedScenes = [...revisedScenes].sort(
    (a, b) => (typeof a["scene_index"] === "number" ? a["scene_index"] as number : 0) - (typeof b["scene_index"] === "number" ? b["scene_index"] as number : 0),
  );
  let noCharacterRun = 0;
  let maxNoCharacterRun = 0;
  for (const sceneEntry of orderedScenes) {
    const hasCharacter = typeof sceneEntry["character_cut_in"] === "string" && sceneEntry["character_cut_in"] !== "none";
    noCharacterRun = hasCharacter ? 0 : noCharacterRun + 1;
    maxNoCharacterRun = Math.max(maxNoCharacterRun, noCharacterRun);
  }
  if (maxNoCharacterRun > 5) {
    failures.push(`${maxNoCharacterRun} consecutive scenes run with character_cut_in "none"; characters must reappear at least every 5 scenes so the episode doesn't read as narration over a slideshow`);
  }

  return { failures };
}

export function makeExplanationPlanReleaseWorker(): WorkerDef {
  return {
    name: "explanation_plan_release",
    kind: "worker",
    version: "6",
    consumes: [
      { schema_id: "explanation_plan", range: "^1", as: "original" },
      { schema_id: "explanation_plan", range: "^1", as: "revised" },
      { schema_id: "explanation_plan_review", range: "^1", as: "review" },
    ],
    produces: "explanation_plan",
    produces_version: "1.7.0",
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
