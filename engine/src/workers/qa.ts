/**
 * QA worker: deterministic integrity + retention-contract measurements.
 * Visual watchability checks are activated only when the hybrid worker marks
 * the manifest with visual_mode, preserving the legacy QA contract for older
 * graphs/tests while making AI-replaced scenes impossible to hide from QA.
 */
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { SCRIPT_QUALITY_THRESHOLDS } from "./script-quality-release.ts";
import { assessDialogueEvidence } from "../script-dialogue-evidence.ts";

export interface QaWorkerOptions {
  maxPlaceholderRatio?: number;
  maxDurationDrift?: number;
  maxScriptDrift?: number;
  wordsPerMinute?: number;
  version?: string;
  enforceDialogueQuality?: boolean;
  name?: string;
}
type Status = "pass" | "warn" | "fail";
interface Check { id: string; status: Status; message: string; measured?: number | null; threshold?: number | null }
interface Intent { target_duration_sec?: number }
interface ScriptScene { scene_index: number; narration?: string }
interface Script { scenes?: ScriptScene[]; word_count?: number }
interface ScriptQualityReport { scores?: Record<string, number>; summary?: string }
interface ShotSegment { start_sec?: number; end_sec?: number; semantic_text?: string }
interface AssetScene {
  scene_index?: number;
  source?: string;
  template_category?: string;
  template_data?: string;
  image_uri?: string;
  image_uris?: string[];
  video_uri?: string;
  visual_mode?: "motion_graphic" | "ai_broll";
  continuity_group?: string;
  style_id?: string;
  palette_id?: string;
  entity_ids?: string[];
  visible_character_ids?: string[];
  duration_sec?: number;
  shot_types?: string[];
  shot_segments?: ShotSegment[];
  hook_strength?: number;
  hook_strategy?: string;
}
interface Assets { scenes?: AssetScene[]; degraded_count?: number }
interface VoiceClip { scene_index?: number; duration_sec?: number }
interface Voice { clips?: VoiceClip[]; total_duration_sec?: number }
interface Rendered { duration_sec?: number; scene_count?: number; degraded_scenes?: number }
interface Thumb { background?: string; text?: string }
interface Seo { title?: string; description?: string; tags?: string[] }

const pct = (n: number) => `${Math.round(n * 100)}%`;
const words = (value: string | undefined) => (value ?? "").trim().split(/\s+/).filter(Boolean);
function decoded(scene: AssetScene): Record<string, unknown> {
  try {
    const value = scene.template_data ? JSON.parse(scene.template_data) as unknown : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
function performance(scene: AssetScene): Record<string, unknown> {
  const data = decoded(scene);
  return data.rendererPerformance && typeof data.rendererPerformance === "object" ? data.rendererPerformance as Record<string, unknown> : {};
}
function validShotSemantics(scene: AssetScene): boolean {
  if (scene.visual_mode !== "ai_broll") return true;
  const imageCount = scene.image_uris?.length ?? (scene.image_uri ? 1 : 0);
  const segments = scene.shot_segments ?? [];
  const duration = scene.duration_sec ?? 0;
  if (!imageCount || imageCount !== segments.length || imageCount !== (scene.shot_types?.length ?? 0)) return false;
  if (Math.abs((segments[0]?.start_sec ?? 99) - 0) > 0.05) return false;
  if (Math.abs((segments.at(-1)?.end_sec ?? -1) - duration) > 0.08) return false;
  return segments.every((segment, i) => {
    if (typeof segment.start_sec !== "number" || typeof segment.end_sec !== "number" || segment.end_sec <= segment.start_sec || !segment.semantic_text?.trim()) return false;
    return i === 0 || Math.abs(segment.start_sec - (segments[i - 1]?.end_sec ?? segment.start_sec)) <= 0.08;
  });
}
function longestMotionRun(scenes: AssetScene[]): number {
  let current = 0, longest = 0;
  for (const scene of scenes) {
    const duration = scene.duration_sec ?? 0;
    if (scene.visual_mode === "ai_broll") current = 0;
    else { current += duration; longest = Math.max(longest, current); }
  }
  return longest;
}

export function makeQaWorker(opts: QaWorkerOptions = {}): WorkerDef {
  const maxPlaceholderRatio = opts.maxPlaceholderRatio ?? 0.1;
  const maxDurationDrift = opts.maxDurationDrift ?? 0.25;
  const maxScriptDrift = opts.maxScriptDrift ?? 0.3;
  const wpm = opts.wordsPerMinute ?? 150;
  const enforceDialogueQuality = opts.enforceDialogueQuality ?? false;
  return {
    name: opts.name ?? "qa",
    kind: "worker",
    version: opts.version ?? (enforceDialogueQuality ? "4" : "1"),
    consumes: [
      { schema_id: "intent", range: "^1", as: "intent" },
      { schema_id: "script", range: "^1", as: "script" },
      ...(enforceDialogueQuality ? [{ schema_id: "script_quality_report", range: "^1", as: "script_quality" }] : []),
      { schema_id: "asset_manifest", range: "^1", as: "assets" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "rendered_video", range: "^1", as: "render" },
      { schema_id: "thumbnail", range: "^1", as: "thumbnail" },
      { schema_id: "seo_metadata", range: "^1", as: "seo" },
    ],
    produces: "qa_report",
    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const intent = inputs["intent"]!.payload as Intent;
      const script = inputs["script"]!.payload as Script;
      const quality = enforceDialogueQuality ? inputs["script_quality"]!.payload as ScriptQualityReport : null;
      const assets = inputs["assets"]!.payload as Assets;
      const voice = inputs["voice"]!.payload as Voice;
      const render = inputs["render"]!.payload as Rendered;
      const thumb = inputs["thumbnail"]!.payload as Thumb;
      const seo = inputs["seo"]!.payload as Seo;
      const checks: Check[] = [];
      const sceneCount = script.scenes?.length ?? 0;
      const targetSec = intent.target_duration_sec ?? 0;
      const visualScenes = [...(assets.scenes ?? [])].sort((a, b) => (a.scene_index ?? 0) - (b.scene_index ?? 0));
      const hybridContract = visualScenes.some((scene) => scene.visual_mode !== undefined);

      if (quality) for (const [dimension, threshold] of Object.entries(SCRIPT_QUALITY_THRESHOLDS)) {
        const score = quality.scores?.[dimension];
        checks.push(typeof score === "number" && score >= threshold
          ? { id: `script_${dimension}`, status: "pass", message: `${dimension.replaceAll("_", " ")} ${score.toFixed(2)} meets ${threshold.toFixed(2)}`, measured: score, threshold }
          : { id: `script_${dimension}`, status: "fail", message: typeof score === "number" ? `${dimension.replaceAll("_", " ")} ${score.toFixed(2)} is below ${threshold.toFixed(2)}` : `${dimension.replaceAll("_", " ")} was not scored by the independent critic (0/${threshold.toFixed(2)})`, measured: typeof score === "number" ? score : null, threshold });
      }
      if (enforceDialogueQuality) {
        const evidence = assessDialogueEvidence(script);
        for (const item of evidence.checks) checks.push({ id: `dialogue_${item.id}`, status: item.passed ? "pass" : "fail", message: `${item.passed ? "1/1" : "0/1"} evidence: ${item.message}`, measured: item.passed ? 1 : 0, threshold: 1 });
      }

      if (enforceDialogueQuality) {
        // AI scenes retain deterministic template_data even though their image
        // renderer path omits template_category. Measure authored explanatory
        // intent rather than letting a modality switch shrink the denominator.
        const explanationScenes = visualScenes.filter((scene) => scene.template_category === "explanation" || Object.keys(performance(scene)).length > 0);
        if (explanationScenes.length > 0) {
          const perf = explanationScenes.map(performance);
          const modelScenes = explanationScenes.filter((scene, i) => {
            if (perf[i]?.explanatoryModelVisible !== true) return false;
            return scene.visual_mode === "ai_broll" ? Boolean(scene.entity_ids?.length && validShotSemantics(scene)) : true;
          }).length;
          const characterScenes = explanationScenes.filter((scene, i) => {
            // Hybrid assets explicitly report what the rendered scene is expected
            // to show. If that telemetry is absent, retain the old conservative
            // behavior: anything other than an explicit "none" counts against
            // the character-restraint budget, including undefined metadata.
            if (scene.visible_character_ids !== undefined) return scene.visible_character_ids.length > 0;
            return perf[i]?.characterCutIn !== "none";
          }).length;
          const changedScenes = explanationScenes.filter((scene, i) => perf[i]?.meaningfulStateChange === true && validShotSemantics(scene)).length;
          const denominator = Math.max(1, explanationScenes.length);
          const modelRatio = modelScenes / denominator, characterRatio = characterScenes / denominator, changeRatio = changedScenes / denominator;
          checks.push(modelRatio >= 0.6
            ? { id: "explanation_model_coverage", status: "pass", message: `${pct(modelRatio)} of explanation scenes visibly carry the model`, measured: modelRatio, threshold: 0.6 }
            : { id: "explanation_model_coverage", status: "fail", message: `only ${pct(modelRatio)} of ${denominator} explanation scenes visibly carry the model`, measured: modelRatio, threshold: 0.6 });
          checks.push(characterRatio <= 0.35
            ? { id: "character_cut_in_restraint", status: "pass", message: `characters are visual cut-ins in ${pct(characterRatio)} of scenes`, measured: characterRatio, threshold: 0.35 }
            : { id: "character_cut_in_restraint", status: "fail", message: `characters occupy ${pct(characterRatio)} of ${denominator} explanation scenes; maximum is 35%`, measured: characterRatio, threshold: 0.35 });
          checks.push(changeRatio >= 0.45
            ? { id: "meaningful_state_change", status: "pass", message: `${pct(changeRatio)} of explanation scenes show a causal/state change`, measured: changeRatio, threshold: 0.45 }
            : { id: "meaningful_state_change", status: "fail", message: `only ${pct(changeRatio)} of ${denominator} explanation scenes show a causal/state change`, measured: changeRatio, threshold: 0.45 });
        }
      }

      if (enforceDialogueQuality && hybridContract) {
        const ai = visualScenes.filter((scene) => scene.visual_mode === "ai_broll");
        const invalid = ai.filter((scene) => !validShotSemantics(scene));
        checks.push(invalid.length === 0
          ? { id: "ai_shot_semantics", status: "pass", message: ai.length ? `${ai.length} AI scenes have narration-aligned shot windows` : "0 AI scenes; deterministic fallback is active", measured: invalid.length, threshold: 0 }
          : { id: "ai_shot_semantics", status: "fail", message: `${invalid.length}/${ai.length} AI scenes have missing or discontinuous narration-shot windows`, measured: invalid.length, threshold: 0 });

        const missingCharacterTelemetry = ai.filter((scene) => scene.visible_character_ids === undefined).length;
        checks.push(missingCharacterTelemetry === 0
          ? { id: "ai_character_visibility_telemetry", status: "pass", message: ai.length ? `${ai.length} AI scenes explicitly report visible characters` : "0 AI scenes; no AI character telemetry required", measured: 0, threshold: 0 }
          : { id: "ai_character_visibility_telemetry", status: "fail", message: `${missingCharacterTelemetry}/${ai.length} AI scenes omit visible-character telemetry`, measured: missingCharacterTelemetry, threshold: 0 });

        const styles = new Set(visualScenes.map((scene) => `${scene.style_id ?? "missing"}|${scene.palette_id ?? "missing"}`));
        checks.push(styles.size === 1 && ![...styles][0]!.includes("missing")
          ? { id: "visual_style_continuity", status: "pass", message: `${visualScenes.length} scenes share one motion/AI style and semantic palette contract`, measured: 1, threshold: 1 }
          : { id: "visual_style_continuity", status: "fail", message: `${styles.size} style/palette contracts appear across ${visualScenes.length} scenes; expected exactly 1`, measured: styles.size, threshold: 1 });

        const motionRun = longestMotionRun(visualScenes);
        checks.push(motionRun <= 16
          ? { id: "visual_reset_cadence", status: "pass", message: `longest uninterrupted motion-graphics run is ${motionRun.toFixed(1)}s`, measured: motionRun, threshold: 16 }
          : { id: "visual_reset_cadence", status: "warn", message: `${motionRun.toFixed(1)}s passes without an AI visual-language reset; target is 16s or less`, measured: motionRun, threshold: 16 });

        const first = visualScenes.find((scene) => scene.scene_index === 0);
        const threshold = first?.visual_mode === "ai_broll" ? 0.6 : 0.45;
        const strength = first?.hook_strength;
        const renderable = Boolean(first && first.source !== "placeholder" && (first.image_uri || first.video_uri || first.template_category));
        checks.push(renderable && typeof strength === "number" && strength >= threshold
          ? { id: "opening_visual_hook", status: "pass", message: `scene 0 ${first?.hook_strategy ?? "visual"} hook measures ${strength.toFixed(2)}`, measured: strength, threshold }
          : { id: "opening_visual_hook", status: "fail", message: !renderable ? "scene 0 has 0 renderable visual sources" : `scene 0 hook evidence is ${typeof strength === "number" ? strength.toFixed(2) : "0.00"}; minimum is ${threshold.toFixed(2)}`, measured: typeof strength === "number" ? strength : 0, threshold });

        const last = visualScenes.at(-1);
        const firstIds = new Set(first?.entity_ids ?? []), lastIds = last?.entity_ids ?? [];
        if (firstIds.size && lastIds.length) {
          const shared = lastIds.filter((id) => firstIds.has(id)).length;
          checks.push(shared > 0
            ? { id: "bookend_entity_continuity", status: "pass", message: `${shared} opening entity identities return in the closing payoff`, measured: shared, threshold: 1 }
            : { id: "bookend_entity_continuity", status: "fail", message: `0 stable entity identities connect opening and closing; minimum is 1`, measured: 0, threshold: 1 });
        }
        if (last) {
          const data = decoded(last);
          const payoff = data.visualOperation === "payoff" && Boolean(String(data.keyText ?? data.after ?? "").trim());
          checks.push(payoff
            ? { id: "closing_visible_payoff", status: "pass", message: "closing scene has 1 explicit visible payoff transformation" }
            : { id: "closing_visible_payoff", status: "fail", message: "closing scene has 0 explicit payoff transformations; minimum is 1", measured: 0, threshold: 1 });
        }

        // This is deliberately only a warning. Visual novelty cannot fully
        // rescue a stop-start voice track, but this heuristic must never be
        // allowed to halt production on its own.
        if (script.scenes?.length && voice.clips?.length) {
          const byScript = new Map(script.scenes.map((scene) => [scene.scene_index, scene]));
          const excessive = voice.clips.filter((clip) => {
            const count = words(byScript.get(clip.scene_index ?? -1)?.narration).length;
            const duration = clip.duration_sec ?? 0;
            if (!count || !duration) return false;
            const expected = count / (wpm / 60) + 0.18;
            return duration - expected > 0.7;
          }).length;
          const risk = excessive / Math.max(1, voice.clips.length);
          checks.push({ id: "voice_stop_start_risk", status: risk <= 0.25 ? "pass" : "warn", message: excessive ? `${excessive}/${voice.clips.length} voice clips exceed their spoken-word duration budget by more than 0.7s` : "0 voice clips show excessive duration padding", measured: risk, threshold: 0.25 });
        }
      }

      const placeholders = assets.degraded_count ?? visualScenes.filter((s) => s.source === "placeholder").length;
      const ratio = sceneCount > 0 ? placeholders / sceneCount : 0;
      checks.push(placeholders === 0
        ? { id: "visual_assets_renderable", status: "pass", message: "every scene has a renderable visual asset" }
        : ratio <= maxPlaceholderRatio
          ? { id: "visual_assets_renderable", status: "warn", message: `${placeholders} of ${sceneCount} scenes used a degraded visual fallback`, measured: ratio, threshold: maxPlaceholderRatio }
          : { id: "visual_assets_renderable", status: "fail", message: `${placeholders} of ${sceneCount} scenes lack their intended renderable asset (${pct(ratio)}) — the visual asset pipeline is failing`, measured: ratio, threshold: maxPlaceholderRatio });

      const clips = voice.clips?.length ?? 0;
      checks.push(clips === sceneCount
        ? { id: "narration_complete", status: "pass", message: `${clips} clips for ${sceneCount} scenes` }
        : { id: "narration_complete", status: "fail", message: `${clips} voice clips for ${sceneCount} scenes — the video would have silent stretches`, measured: clips, threshold: sceneCount });
      const rendered = render.scene_count ?? 0;
      checks.push(rendered === sceneCount
        ? { id: "scenes_rendered", status: "pass", message: `all ${sceneCount} scenes rendered` }
        : { id: "scenes_rendered", status: "fail", message: `renderer reported ${rendered} scenes, the script has ${sceneCount}`, measured: rendered, threshold: sceneCount });

      if (targetSec > 0 && typeof render.duration_sec === "number") {
        const drift = Math.abs(render.duration_sec - targetSec) / targetSec;
        checks.push(drift <= maxDurationDrift
          ? { id: "duration", status: "pass", message: `${Math.round(render.duration_sec)}s against a ${targetSec}s target`, measured: drift, threshold: maxDurationDrift }
          : { id: "duration", status: "fail", message: `${Math.round(render.duration_sec)}s against a ${targetSec}s target (${pct(drift)} off)`, measured: drift, threshold: maxDurationDrift });
      } else checks.push({ id: "duration", status: "warn", message: "no rendered duration reported, so length could not be checked", measured: null });

      if (targetSec > 0 && typeof script.word_count === "number" && script.word_count > 0) {
        const budget = (targetSec / 60) * wpm;
        const drift = Math.abs(script.word_count - budget) / budget;
        checks.push({ id: "script_length", status: drift <= maxScriptDrift ? "pass" : "warn", message: `${script.word_count} words against a ~${Math.round(budget)} word budget`, measured: drift, threshold: maxScriptDrift });
      }
      checks.push(thumb.background === "supplied"
        ? { id: "thumbnail_image", status: "pass", message: "thumbnail uses a real photograph" }
        : { id: "thumbnail_image", status: "warn", message: `thumbnail background is "${thumb.background ?? "unknown"}", not a photograph — worse, but still a designed thumbnail` });

      const title = seo.title ?? "", description = seo.description ?? "";
      const tagChars = (seo.tags ?? []).reduce((n, t) => n + t.length, 0);
      const problems: string[] = [];
      if (title.length > 100) problems.push(`title ${title.length}/100 chars`);
      if (description.length > 5000) problems.push(`description ${description.length}/5000`);
      if (tagChars > 500) problems.push(`tags ${tagChars}/500 chars`);
      checks.push(problems.length === 0
        ? { id: "metadata_limits", status: "pass", message: "title, description and tags fit" }
        : { id: "metadata_limits", status: "fail", message: `YouTube would reject this upload: ${problems.join("; ")}` });

      const failed = checks.filter((c) => c.status === "fail").length;
      const warned = checks.filter((c) => c.status === "warn").length;
      const verdict = failed > 0 ? "fail" : "pass";
      for (const c of checks.filter((c) => c.status !== "pass")) {
        const log = c.status === "fail" ? ctx.logger.error : ctx.logger.warn;
        log(`[qa] ${c.status.toUpperCase()} ${c.id}: ${c.message}`);
      }
      await ctx.progress({ detail: `qa ${verdict}: ${failed} failed, ${warned} warned` });
      return { payload: { verdict, failed, warned, checks: checks.map((c) => ({ id: c.id, status: c.status, message: c.message, ...(c.measured !== undefined ? { measured: c.measured } : {}), ...(c.threshold !== undefined ? { threshold: c.threshold } : {}) })) } };
    },
  };
}
