import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV14CartoonSceneCompilerWorker } from "./cartoon-scenes-v14.ts";

type PlannerFraming =
  | "establishing"
  | "two-shot"
  | "speaker-closeup"
  | "listener-closeup"
  | "reaction-closeup"
  | "prop-insert"
  | "over-shoulder"
  | "doorway-transition"
  | "payoff-hold";

type PlannerCameraMotion =
  | "static"
  | "push-in"
  | "pull-out"
  | "pan-left"
  | "pan-right"
  | "reaction-push"
  | "prop-focus"
  | "doorway-track"
  | "payoff-hold";

type ShotRecipe =
  | "establishing"
  | "two-shot"
  | "reaction-closeup"
  | "prop-insert"
  | "over-shoulder"
  | "crossing-transition"
  | "callback-reveal"
  | "payoff-hold";

type RendererShotType =
  | "wide"
  | "medium"
  | "close-up"
  | "prop-close-up"
  | "doorway-transition"
  | "counter-shot"
  | "table-shot";

type CameraIntent = "static" | "slow-push" | "reaction-push" | "prop-focus" | "doorway-track" | "payoff-hold";

interface PlanScene {
  scene_index: number;
  framing?: PlannerFraming | string;
  camera_motion?: PlannerCameraMotion | string;
}

interface CompiledEntry {
  scene_index: number;
  source: "template";
  template_category: "cartoon";
  template_data: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function plannerRecipe(framing: unknown, fallback: ShotRecipe): ShotRecipe {
  switch (framing) {
    case "establishing": return "establishing";
    case "two-shot": return "two-shot";
    case "speaker-closeup":
    case "listener-closeup":
    case "reaction-closeup": return "reaction-closeup";
    case "prop-insert": return "prop-insert";
    case "over-shoulder": return "over-shoulder";
    case "doorway-transition": return "crossing-transition";
    case "payoff-hold": return "payoff-hold";
    default: return fallback;
  }
}

function shotTypeForRecipe(recipe: ShotRecipe, fallback: RendererShotType): RendererShotType {
  switch (recipe) {
    case "establishing": return "wide";
    case "reaction-closeup": return "close-up";
    case "prop-insert": return "prop-close-up";
    case "over-shoulder": return "medium";
    case "crossing-transition": return "doorway-transition";
    case "payoff-hold": return "medium";
    case "callback-reveal": return "close-up";
    case "two-shot": return "medium";
    default: return fallback;
  }
}

function cameraIntentForPlan(motion: unknown, fallback: CameraIntent): CameraIntent {
  switch (motion) {
    case "static": return "static";
    case "push-in": return "slow-push";
    case "reaction-push": return "reaction-push";
    case "prop-focus": return "prop-focus";
    case "doorway-track": return "doorway-track";
    case "payoff-hold": return "payoff-hold";
    // The base compiler's `camera` object already executes these motions.
    // Keep the cinematic layer static so it does not fight/double the move.
    case "pull-out":
    case "pan-left":
    case "pan-right": return "static";
    default: return fallback;
  }
}

function qualityTagsWithPlannerAuthority(raw: unknown, recipe: ShotRecipe, framing: unknown): string[] {
  const tags = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  const filtered = tags.filter((tag) => !tag.startsWith("recipe:") && !tag.startsWith("planner-framing:"));
  return [...filtered, `recipe:${recipe}`, `planner-framing:${String(framing ?? "legacy")}`, "planner-shot-authority"];
}

/**
 * v8-v14 are compatibility layers accumulated across renderer generations.
 * Some of those layers intentionally derived shot metadata from creative text,
 * but that became incorrect once visual_plan@1.9 added validated cinematic
 * framings. This final boundary restores the visual planner as the authority.
 *
 * Heuristics remain as fallback only when a legacy plan omitted modern fields.
 */
export function applyPlannerShotAuthority(entries: CompiledEntry[], planScenes: PlanScene[]): CompiledEntry[] {
  const planByIndex = new Map(planScenes.map((scene) => [scene.scene_index, scene]));

  return entries.map((entry) => {
    const plan = planByIndex.get(entry.scene_index);
    if (!plan) return entry;

    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const cinematic = asRecord(compiled.cinematic) ?? {};
    const performance = asRecord(compiled.rendererPerformance) ?? {};
    const shot = asRecord(compiled.shot) ?? {};

    const fallbackRecipe = typeof cinematic.shotRecipe === "string"
      ? cinematic.shotRecipe as ShotRecipe
      : "two-shot";
    const recipe = plannerRecipe(plan.framing, fallbackRecipe);
    const fallbackShotType = typeof compiled.shotType === "string"
      ? compiled.shotType as RendererShotType
      : "medium";
    const fallbackCameraIntent = typeof cinematic.cameraIntent === "string"
      ? cinematic.cameraIntent as CameraIntent
      : "static";

    const next = {
      ...compiled,
      shotType: shotTypeForRecipe(recipe, fallbackShotType),
      shot: {
        ...shot,
        framing: typeof plan.framing === "string" ? plan.framing : shot.framing,
      },
      cinematic: {
        ...cinematic,
        shotRecipe: recipe,
        cameraIntent: cameraIntentForPlan(plan.camera_motion, fallbackCameraIntent),
        qualityTags: qualityTagsWithPlannerAuthority(cinematic.qualityTags, recipe, plan.framing),
      },
      rendererPerformance: {
        ...performance,
        shotRecipe: recipe,
        shotType: shotTypeForRecipe(recipe, fallbackShotType),
        plannedFraming: plan.framing,
        plannerShotAuthority: true,
      },
    };

    return { ...entry, template_data: JSON.stringify(next) };
  });
}

function visualPlan(inputs: Record<string, { payload?: unknown } | undefined>): PlanScene[] {
  const payload = asRecord(inputs["plan"]?.payload);
  return Array.isArray(payload?.scenes) ? payload.scenes as PlanScene[] : [];
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const v14 = makeV14CartoonSceneCompilerWorker();
  return {
    ...v14,
    version: "16",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await v14.execute(inputs, ctx);
      const plans = visualPlan(inputs as Record<string, { payload?: unknown } | undefined>);
      if (!plans.length) return out;

      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const scenes = applyPlannerShotAuthority(payload.scenes, plans);
      return { ...out, payload: { ...payload, scenes } };
    },
  };
}
