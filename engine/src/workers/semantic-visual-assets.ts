import type { Artifact } from "../artifact.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export type RepresentationMode = "concrete-scene" | "domain-model" | "quantitative" | "spatial" | "kinetic-text";
export type SceneBlueprint =
  | "container-object"
  | "molecular-system"
  | "lattice"
  | "cross-section"
  | "mass-volume-comparison"
  | "before-after-object"
  | "animated-statement";

export interface SemanticAction {
  actor: string;
  action: string;
  target: string;
  anchor_phrase: string;
}

export interface SemanticActionWindow {
  actor: string;
  action: string;
  target: string;
  startRatio: number;
  endRatio: number;
  aligned: boolean;
}

interface PlanScene {
  scene_index: number;
  representation_mode?: RepresentationMode;
  scene_blueprint?: SceneBlueprint;
  visual_claim?: string;
  visual_actions?: SemanticAction[];
}

interface ScriptScene { scene_index: number; narration?: string }
interface VoiceClip { scene_index: number; alignment_uri?: string; duration_sec?: number }
interface AlignmentData {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}
interface AssetScene {
  scene_index: number;
  template_data?: string;
  [key: string]: unknown;
}

export const SUPPORTED_BLUEPRINTS = new Set<SceneBlueprint>([
  "container-object",
  "molecular-system",
  "lattice",
  "cross-section",
  "mass-volume-comparison",
  "before-after-object",
  "animated-statement",
]);

export function blueprintFitsMode(mode: RepresentationMode, blueprint: SceneBlueprint): boolean {
  if (mode === "concrete-scene") return blueprint === "container-object" || blueprint === "before-after-object";
  if (mode === "domain-model") return blueprint === "molecular-system" || blueprint === "lattice";
  if (mode === "quantitative") return blueprint === "mass-volume-comparison";
  if (mode === "spatial") return blueprint === "cross-section";
  return blueprint === "animated-statement";
}

function clean(value: unknown, max = 180): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function roundRatio(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

/**
 * Normalise text while preserving a map back to original character offsets.
 * Alignment providers return timing per source character, while planner anchor
 * phrases may differ only in punctuation/case/whitespace. Removing punctuation
 * without this map would make a successful text match unusable for timing.
 */
export function normaliseWithMap(text: string): { text: string; sourceIndex: number[] } {
  let out = "";
  const sourceIndex: number[] = [];
  let pendingSpace = false;
  let pendingSpaceIndex = 0;

  for (let i = 0; i < text.length; i++) {
    const raw = text[i]!;
    const lower = raw.toLocaleLowerCase();
    if (/[\p{L}\p{N}]/u.test(lower)) {
      if (pendingSpace && out.length > 0 && !out.endsWith(" ")) {
        out += " ";
        sourceIndex.push(pendingSpaceIndex);
      }
      pendingSpace = false;
      out += lower;
      sourceIndex.push(i);
    } else {
      pendingSpace = true;
      pendingSpaceIndex = i;
    }
  }
  return { text: out.trim(), sourceIndex };
}

function alignedAnchorWindow(
  anchorPhrase: string,
  alignment: AlignmentData | null,
  durationSec: number,
): { startRatio: number; endRatio: number } | null {
  if (!alignment?.characters?.length || !alignment.character_start_times_seconds?.length || !alignment.character_end_times_seconds?.length || !(durationSec > 0)) return null;
  const source = alignment.characters.join("");
  const normalSource = normaliseWithMap(source);
  const normalAnchor = normaliseWithMap(anchorPhrase).text;
  if (!normalAnchor) return null;
  const at = normalSource.text.indexOf(normalAnchor);
  if (at < 0) return null;
  const sourceStart = normalSource.sourceIndex[at];
  const sourceEnd = normalSource.sourceIndex[Math.min(normalSource.sourceIndex.length - 1, at + normalAnchor.length - 1)];
  if (sourceStart === undefined || sourceEnd === undefined) return null;
  const startSec = alignment.character_start_times_seconds[sourceStart];
  const endSec = alignment.character_end_times_seconds[sourceEnd];
  if (typeof startSec !== "number" || typeof endSec !== "number") return null;

  // Give the explanatory change enough visible time to read, while keeping its
  // centre anchored to the spoken phrase. The renderer interpolates inside
  // this window rather than using one universal scene-level progress curve.
  const rawStart = startSec / durationSec - 0.035;
  const rawEnd = endSec / durationSec + 0.11;
  const minWidth = 0.14;
  const startRatio = Math.max(0.02, rawStart);
  const endRatio = Math.min(0.96, Math.max(rawEnd, startRatio + minWidth));
  return { startRatio: roundRatio(startRatio), endRatio: roundRatio(endRatio) };
}

export function resolveActionWindows(
  actions: SemanticAction[],
  narration: string,
  alignment: AlignmentData | null,
  durationSec: number,
): SemanticActionWindow[] {
  if (!actions.length) return [];
  const count = actions.length;
  const fallbackSpan = 0.78;
  const fallbackWidth = Math.max(0.16, Math.min(0.3, fallbackSpan / Math.max(1, count)));

  return actions.map((raw, index) => {
    const actor = clean(raw.actor, 48) || "subject";
    const action = clean(raw.action, 32) || "reveal";
    const target = clean(raw.target, 48);
    const anchor = clean(raw.anchor_phrase, 96);
    const aligned = anchor ? alignedAnchorWindow(anchor, alignment, durationSec) : null;
    if (aligned) return { actor, action, target, ...aligned, aligned: true };

    // No alignment is better than false alignment. Preserve action order and
    // spread transformations through the spoken turn so the scene still has a
    // setup -> mechanism -> consequence rhythm rather than completing at t=0.
    const centre = count === 1 ? 0.5 : 0.12 + (fallbackSpan * index) / Math.max(1, count - 1);
    const startRatio = roundRatio(Math.max(0.04, centre - fallbackWidth / 2));
    const endRatio = roundRatio(Math.min(0.94, Math.max(startRatio + 0.14, centre + fallbackWidth / 2)));
    return { actor, action, target, startRatio, endRatio, aligned: false };
  });
}

function parseTemplateData(scene: AssetScene): Record<string, unknown> {
  try {
    const parsed = scene.template_data ? JSON.parse(scene.template_data) as unknown : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function semanticPayload(
  base: Record<string, unknown>,
  plan: PlanScene,
  windows: SemanticActionWindow[],
): Record<string, unknown> {
  let mode = plan.representation_mode;
  let blueprint = plan.scene_blueprint;
  const claim = clean(plan.visual_claim, 180) || clean(base["keyText"] ?? base["after"] ?? "Main idea", 180);

  // Fail closed to text. This is the architectural invariant this worker
  // exists to enforce: unsupported semantic intent never falls through into
  // generic node/box geometry.
  if (!mode || !blueprint || !SUPPORTED_BLUEPRINTS.has(blueprint) || !blueprintFitsMode(mode, blueprint)) {
    mode = "kinetic-text";
    blueprint = "animated-statement";
    windows = [];
  }
  if (mode !== "kinetic-text" && windows.length === 0) {
    mode = "kinetic-text";
    blueprint = "animated-statement";
  }

  const performance = base["rendererPerformance"] && typeof base["rendererPerformance"] === "object"
    ? base["rendererPerformance"] as Record<string, unknown> : {};

  return {
    ...base,
    representationMode: mode,
    sceneBlueprint: blueprint,
    visualClaim: claim,
    semanticActionWindows: windows,
    semanticFallback: mode === "kinetic-text",
    rendererPerformance: {
      ...performance,
      semanticRepresentation: true,
      representationMode: mode,
      sceneBlueprint: blueprint,
      semanticFallback: mode === "kinetic-text",
      meaningfulStateChange: mode === "kinetic-text" ? performance["meaningfulStateChange"] === true : windows.length > 0,
    },
  };
}

export function makeSemanticVisualAssetsWorker(): WorkerDef {
  return {
    name: "semantic_visual_assets",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "asset_manifest", range: "^1", as: "compiled" },
      { schema_id: "explanation_plan", range: "^1", as: "plan" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
    ],
    produces: "asset_manifest",
    produces_version: "1.7.0",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const compiled = inputs["compiled"]!.payload as { scenes: AssetScene[]; degraded_count?: number };
      const plans = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes ?? [];
      const scripts = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes ?? [];
      const clips = (inputs["voice"]!.payload as { clips: VoiceClip[] }).clips ?? [];
      const planBy = new Map(plans.map((scene) => [scene.scene_index, scene]));
      const scriptBy = new Map(scripts.map((scene) => [scene.scene_index, scene]));
      const clipBy = new Map(clips.map((clip) => [clip.scene_index, clip]));

      const scenes: AssetScene[] = [];
      for (const scene of compiled.scenes) {
        const plan = planBy.get(scene.scene_index);
        if (!plan) { scenes.push(scene); continue; }
        const script = scriptBy.get(scene.scene_index) ?? { scene_index: scene.scene_index, narration: "" };
        const clip = clipBy.get(scene.scene_index);
        const durationSec = typeof clip?.duration_sec === "number" && clip.duration_sec > 0 ? clip.duration_sec : 1;
        let alignment: AlignmentData | null = null;
        if (clip?.alignment_uri) {
          try {
            alignment = JSON.parse(new TextDecoder().decode(await ctx.blobs.get(clip.alignment_uri))) as AlignmentData;
          } catch (error) {
            ctx.logger.warn(`[semantic_visual_assets] scene ${scene.scene_index} alignment unavailable; distributing semantic actions deterministically: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const actions = Array.isArray(plan.visual_actions) ? plan.visual_actions : [];
        const windows = resolveActionWindows(actions, script.narration ?? "", alignment, durationSec);
        const payload = semanticPayload(parseTemplateData(scene), plan, windows);
        const encoded = JSON.stringify(payload);
        if (encoded.length > 8000) {
          throw new Error(`semantic visual scene ${scene.scene_index} template_data exceeds 8000 characters after semantic metadata (${encoded.length})`);
        }
        scenes.push({ ...scene, template_data: encoded });
      }

      return { payload: { scenes, degraded_count: compiled.degraded_count ?? 0 } };
    },
  };
}
