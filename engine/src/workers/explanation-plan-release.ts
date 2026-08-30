import type { WorkerDef, WorkerOutput } from "../runner.ts";

// The deterministic half of the storyboard review gate.
//
// explanation_plan_critic judges the plan and explanation_plan_reviser
// rewrites the scenes it flagged, but a critic/reviser pair has one classic
// failure mode that no amount of prompting reliably removes: the reviser
// agrees with the critique, says so, and returns the flagged scene
// unchanged. The loop then reports success while nothing improved. This
// worker is what makes the review a gate rather than a suggestion -- it
// compares the revision against the plan that was criticised and rejects a
// pass where a flagged scene did not actually move.
//
// It also runs the structural checks the critic cannot be trusted on,
// because they are facts about the artifact rather than judgements: a
// relationship primitive left with no model_relations renders the renderer's
// fixed fallback topology (the exact defect explanation_plan@1.5.0 exists to
// remove), and a relation index past the end of its own model_elements
// silently drops a connection the plan thought it had authored.

// Primitives whose geometry is a relationship between named entities. Each
// falls back to a fixed, episode-independent topology when model_relations
// is empty -- see the `network` branch in MotionDesignSystem.tsx.
const RELATIONSHIP_PRIMITIVES = new Set([
  "network",
  "hierarchy",
  "one-to-many",
  "many-to-one",
  "cause-chain",
]);

// Same philosophy as script_quality_release: after this many attempts still
// fail the bar, accept the latest revision rather than blocking a run
// forever. A gate with no escape hatch depends on an operator noticing the
// block, and offers no guarantee the next attempt fares better.
const MAX_ATTEMPTS_BEFORE_ACCEPTING = 3;

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

// Key order is not meaningful in a plan scene, and an agent re-emitting a
// scene will not preserve it. Comparing raw JSON.stringify output would
// report a key reshuffle as a revision, which is precisely the no-op this
// gate exists to catch.
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
    // A `weak` verdict is the revision instruction. failure_mode is also
    // honoured on its own: a critic that names a concrete defect but leaves
    // the verdict at `adequate` has still found something, and letting that
    // through unrevised would make the verdict field the only thing that
    // matters about a review.
    const weak = scene.verdict === "weak";
    const defective = typeof scene.failure_mode === "string" && scene.failure_mode !== "none" && scene.failure_mode !== "";
    if (weak || defective) flagged.push(scene.scene_index);
  }
  return [...new Set(flagged)].sort((a, b) => a - b);
}

export function assessPlanRevision(original: unknown, revised: unknown, review: unknown): { failures: string[] } {
  const failures: string[] = [];
  const originalScenes = byIndex(scenesOf(original));
  const revisedScenes = scenesOf(revised);
  const revisedByIndex = byIndex(revisedScenes);

  if (revisedScenes.length === 0) {
    return { failures: ["revised plan has no scenes"] };
  }
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
    if (before && stableJson(before) === stableJson(after)) {
      failures.push(`scene ${index} was flagged for revision but came back byte-identical`);
    }
  }

  // Structural checks on the revision itself. These are facts, not
  // judgements, so they are checked here rather than being left to the
  // critic's opinion.
  let relationshipScenes = 0;
  let unauthored = 0;
  for (const scene of revisedScenes) {
    const index = typeof scene["scene_index"] === "number" ? scene["scene_index"] : -1;
    const primitive = typeof scene["visual_primitive"] === "string" ? scene["visual_primitive"] : "";
    const elements = Array.isArray(scene["model_elements"]) ? scene["model_elements"] : [];
    const relations = Array.isArray(scene["model_relations"]) ? scene["model_relations"] : [];

    for (const relation of relations) {
      if (!relation || typeof relation !== "object") continue;
      const record = relation as Record<string, unknown>;
      for (const end of ["from_element", "to_element"] as const) {
        const value = record[end];
        // Out of range is worse than absent: the plan believes it authored a
        // connection that will never be drawn, so the critic sees structure
        // the viewer never gets.
        if (typeof value === "number" && Number.isInteger(value) && value >= elements.length) {
          failures.push(`scene ${index} relation ${end}=${value} points past its ${elements.length} model_elements`);
        }
      }
    }

    if (!RELATIONSHIP_PRIMITIVES.has(primitive)) continue;
    relationshipScenes += 1;
    if (relations.length === 0) unauthored += 1;
  }

  // Deliberately a majority rule rather than "any scene". One relationship
  // scene the planner genuinely could not connect should not burn three
  // regenerations of a whole episode; a plan where MOST of them fall back to
  // the fixed topology is the pre-1.5.0 behaviour wearing a new schema, and
  // is worth rejecting.
  if (relationshipScenes > 0 && unauthored * 2 > relationshipScenes) {
    failures.push(
      `${unauthored} of ${relationshipScenes} relationship-primitive scenes authored no model_relations, so most of this episode's diagrams would render the fixed fallback topology`,
    );
  }

  return { failures };
}

export function makeExplanationPlanReleaseWorker(): WorkerDef {
  return {
    name: "explanation_plan_release",
    kind: "worker",
    version: "1",
    consumes: [
      // Positional: the graph supplies the pre-revision plan first, then the
      // revision, then the review that connects them (see bindInputs).
      { schema_id: "explanation_plan", range: "^1", as: "original" },
      { schema_id: "explanation_plan", range: "^1", as: "revised" },
      { schema_id: "explanation_plan_review", range: "^1", as: "review" },
    ],
    produces: "explanation_plan",
    produces_version: "1.5.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const original = inputs["original"]?.payload;
      const revised = inputs["revised"]?.payload;
      const { failures } = assessPlanRevision(original, revised, inputs["review"]?.payload);

      if (failures.length > 0) {
        if (ctx.attemptNumber >= MAX_ATTEMPTS_BEFORE_ACCEPTING) {
          ctx.logger.warn(
            `[explanation_plan_release] attempt ${ctx.attemptNumber}: accepting the revision despite an unmet review ` +
              `rather than blocking indefinitely -- ${failures.join("; ")}`,
          );
        } else {
          throw new Error(
            `explanation plan release blocked (attempt ${ctx.attemptNumber}/${MAX_ATTEMPTS_BEFORE_ACCEPTING}): ` +
              failures.join("; "),
          );
        }
      }

      return { payload: revised };
    },
  };
}
