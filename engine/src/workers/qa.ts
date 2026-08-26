/**
 * QA worker: the finished episode -> qa_report.
 *
 * A worker, emphatically. Every check is a measurement against a declared
 * threshold — no model, no judgement, no opinion. That is the only reason it is
 * safe to gate publication on the result automatically: a check that could be
 * argued with is a check that cannot replace a human.
 *
 * The severity split is the whole design:
 *
 *   fail  the episode is broken or would be rejected by the platform. Blocks.
 *   warn  the episode is worse than intended but watchable. Recorded, ships.
 *
 * Getting that line wrong in either direction is expensive. Too strict and an
 * unattended pipeline stops producing anything over a slightly short script;
 * too loose and it uploads eighty placeholder images to a real channel.
 */

import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { SCRIPT_QUALITY_THRESHOLDS } from "./script-quality-release.ts";
import { assessDialogueEvidence } from "../script-dialogue-evidence.ts";

export interface QaWorkerOptions {
  /** Placeholder images tolerated before it fails, as a fraction of scenes. */
  maxPlaceholderRatio?: number;
  /** How far the rendered video may drift from the requested length. */
  maxDurationDrift?: number;
  /** How far the script word count may drift from the target. */
  maxScriptDrift?: number;
  /** Spoken words per minute, for turning a duration into a word budget. */
  wordsPerMinute?: number;
  version?: string;
  /** Enable comprehension-led dialogue evidence and critic-score publication gates. */
  enforceDialogueQuality?: boolean;
  /** Allows the retention QA variant to coexist with legacy QA graph contracts. */
  name?: string;
}

type Status = "pass" | "warn" | "fail";

interface Check {
  id: string;
  status: Status;
  message: string;
  measured?: number | null;
  threshold?: number | null;
}

interface Intent { target_duration_sec?: number }
interface Script { scenes?: Array<{ scene_index: number }>; word_count?: number }
interface ScriptQualityReport { scores?: Record<string, number>; summary?: string }
interface Assets { scenes?: Array<{ source?: string; template_category?: string; template_data?: string }>; degraded_count?: number }
interface Voice { clips?: Array<{ duration_sec?: number }>; total_duration_sec?: number }
interface Rendered { duration_sec?: number; scene_count?: number; degraded_scenes?: number }
interface Thumb { background?: string; text?: string }
interface Seo { title?: string; description?: string; tags?: string[] }

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function makeQaWorker(opts: QaWorkerOptions = {}): WorkerDef {
  const maxPlaceholderRatio = opts.maxPlaceholderRatio ?? 0.1;
  const maxDurationDrift = opts.maxDurationDrift ?? 0.25;
  const maxScriptDrift = opts.maxScriptDrift ?? 0.3;
  const wpm = opts.wordsPerMinute ?? 150;
  const enforceDialogueQuality = opts.enforceDialogueQuality ?? false;

  return {
    name: opts.name ?? "qa",
    kind: "worker",
    version: opts.version ?? (enforceDialogueQuality ? "3" : "1"),
    consumes: [
      { schema_id: "intent", range: "^1", as: "intent" },
      { schema_id: "script", range: "^1", as: "script" },
      ...(enforceDialogueQuality
        ? [{ schema_id: "script_quality_report", range: "^1", as: "script_quality" }]
        : []),
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
      const scriptQuality = enforceDialogueQuality
        ? inputs["script_quality"]!.payload as ScriptQualityReport
        : null;
      const assets = inputs["assets"]!.payload as Assets;
      const voice = inputs["voice"]!.payload as Voice;
      const render = inputs["render"]!.payload as Rendered;
      const thumb = inputs["thumbnail"]!.payload as Thumb;
      const seo = inputs["seo"]!.payload as Seo;

      const checks: Check[] = [];
      const sceneCount = script.scenes?.length ?? 0;
      const targetSec = intent.target_duration_sec ?? 0;

      // --- product goal: comprehension-led dialogue retention -----------
      // The independent critic was already applied before expensive work.
      // Reassert its per-dimension evidence here so the final publication
      // report describes the actual product goal, not aesthetic polish.
      if (scriptQuality) for (const [dimension, threshold] of Object.entries(SCRIPT_QUALITY_THRESHOLDS)) {
        const score = scriptQuality.scores?.[dimension];
        checks.push(
          typeof score === "number" && score >= threshold
            ? {
              id: `script_${dimension}`,
              status: "pass",
              message: `${dimension.replaceAll("_", " ")} ${score.toFixed(2)} meets ${threshold.toFixed(2)}`,
              measured: score,
              threshold,
            }
            : {
              id: `script_${dimension}`,
              status: "fail",
              message: typeof score === "number"
                ? `${dimension.replaceAll("_", " ")} ${score.toFixed(2)} is below ${threshold.toFixed(2)}`
                : `${dimension.replaceAll("_", " ")} was not scored by the independent critic`,
              measured: typeof score === "number" ? score : null,
              threshold,
            },
        );
      }

      if (enforceDialogueQuality) {
        const evidence = assessDialogueEvidence(script);
        for (const evidenceCheck of evidence.checks) {
          checks.push({
            id: `dialogue_${evidenceCheck.id}`,
            status: evidenceCheck.passed ? "pass" : "fail",
            message: `${evidenceCheck.passed ? "1/1" : "0/1"} evidence: ${evidenceCheck.message}`,
            measured: evidenceCheck.passed ? 1 : 0,
            threshold: 1,
          });
        }
      }

      // --- explanation format owns the frame -----------------------------
      if (enforceDialogueQuality) {
        const explanationScenes = (assets.scenes ?? []).filter((scene) => scene.template_category === "explanation");
        if (explanationScenes.length > 0) {
        const decoded = explanationScenes.map((scene) => {
          try { return scene.template_data ? JSON.parse(scene.template_data) as Record<string, unknown> : {}; }
          catch { return {}; }
        });
        const performance = decoded.map((scene) =>
          scene.rendererPerformance && typeof scene.rendererPerformance === "object"
            ? scene.rendererPerformance as Record<string, unknown>
            : {}
        );
        const modelScenes = performance.filter((item) => item.explanatoryModelVisible === true).length;
        const characterScenes = performance.filter((item) => item.characterCutIn !== "none").length;
        const changedScenes = performance.filter((item) => item.meaningfulStateChange === true).length;
        const denominator = Math.max(1, explanationScenes.length);
        const modelRatio = modelScenes / denominator;
        const characterRatio = characterScenes / denominator;
        const changeRatio = changedScenes / denominator;

        checks.push(modelRatio >= 0.6
          ? { id: "explanation_model_coverage", status: "pass", message: `${pct(modelRatio)} of scenes visibly teach the model`, measured: modelRatio, threshold: 0.6 }
          : { id: "explanation_model_coverage", status: "fail", message: `only ${pct(modelRatio)} of scenes visibly teach the model`, measured: modelRatio, threshold: 0.6 });
        checks.push(characterRatio <= 0.35
          ? { id: "character_cut_in_restraint", status: "pass", message: `characters are visual cut-ins in ${pct(characterRatio)} of scenes`, measured: characterRatio, threshold: 0.35 }
          : { id: "character_cut_in_restraint", status: "fail", message: `characters occupy ${pct(characterRatio)} of scenes; maximum is 35%`, measured: characterRatio, threshold: 0.35 });
        checks.push(changeRatio >= 0.45
          ? { id: "meaningful_state_change", status: "pass", message: `${pct(changeRatio)} of scenes show a causal/state change`, measured: changeRatio, threshold: 0.45 }
          : { id: "meaningful_state_change", status: "fail", message: `only ${pct(changeRatio)} of scenes show a causal/state change`, measured: changeRatio, threshold: 0.45 });
        }
      }

      // --- visual assets are renderable (integrity, not aesthetics) ------ -------------------------------------
      // The most expensive silent failure: the video renders fine and is
      // entirely solid-colour placeholders.
      const placeholders =
        assets.degraded_count ??
        (assets.scenes ?? []).filter((s) => s.source === "placeholder").length;
      const ratio = sceneCount > 0 ? placeholders / sceneCount : 0;
      checks.push(
        placeholders === 0
          ? { id: "visual_assets_renderable", status: "pass", message: "every scene has a renderable visual asset" }
          : ratio <= maxPlaceholderRatio
            ? {
              id: "visual_assets_renderable",
              status: "warn",
              message: `${placeholders} of ${sceneCount} scenes used a degraded visual fallback`,
              measured: ratio,
              threshold: maxPlaceholderRatio,
            }
            : {
              id: "visual_assets_renderable",
              status: "fail",
              message:
                `${placeholders} of ${sceneCount} scenes lack their intended renderable asset (${pct(ratio)}) — ` +
                `the visual asset pipeline is failing, not merely aesthetically imperfect`,
              measured: ratio,
              threshold: maxPlaceholderRatio,
            },
      );

      // --- every scene has narration ------------------------------------
      const clips = voice.clips?.length ?? 0;
      checks.push(
        clips === sceneCount
          ? { id: "narration_complete", status: "pass", message: `${clips} clips for ${sceneCount} scenes` }
          : {
            id: "narration_complete",
            status: "fail",
            message: `${clips} voice clips for ${sceneCount} scenes — the video would have silent stretches`,
            measured: clips,
            threshold: sceneCount,
          },
      );

      // --- the render covered the script --------------------------------
      const rendered = render.scene_count ?? 0;
      checks.push(
        rendered === sceneCount
          ? { id: "scenes_rendered", status: "pass", message: `all ${sceneCount} scenes rendered` }
          : {
            id: "scenes_rendered",
            status: "fail",
            message: `renderer reported ${rendered} scenes, the script has ${sceneCount}`,
            measured: rendered,
            threshold: sceneCount,
          },
      );

      // --- length -------------------------------------------------------
      // A ten-minute slot filled with three minutes of video is a failure the
      // pipeline currently has no other way to notice.
      if (targetSec > 0 && typeof render.duration_sec === "number") {
        const drift = Math.abs(render.duration_sec - targetSec) / targetSec;
        checks.push(
          drift <= maxDurationDrift
            ? {
              id: "duration",
              status: "pass",
              message: `${Math.round(render.duration_sec)}s against a ${targetSec}s target`,
              measured: drift,
              threshold: maxDurationDrift,
            }
            : {
              id: "duration",
              status: "fail",
              message:
                `${Math.round(render.duration_sec)}s against a ${targetSec}s target ` +
                `(${pct(drift)} off)`,
              measured: drift,
              threshold: maxDurationDrift,
            },
        );
      } else {
        checks.push({
          id: "duration",
          status: "warn",
          message: "no rendered duration reported, so length could not be checked",
          measured: null,
        });
      }

      // Script length is a warning, not a failure: the render duration above is
      // the outcome that actually matters, and this only explains it.
      if (targetSec > 0 && typeof script.word_count === "number" && script.word_count > 0) {
        const budget = (targetSec / 60) * wpm;
        const drift = Math.abs(script.word_count - budget) / budget;
        checks.push({
          id: "script_length",
          status: drift <= maxScriptDrift ? "pass" : "warn",
          message: `${script.word_count} words against a ~${Math.round(budget)} word budget`,
          measured: drift,
          threshold: maxScriptDrift,
        });
      }

      // --- thumbnail ----------------------------------------------------
      checks.push(
        thumb.background === "supplied"
          ? { id: "thumbnail_image", status: "pass", message: "thumbnail uses a real photograph" }
          : {
            id: "thumbnail_image",
            status: "warn",
            message:
              `thumbnail background is "${thumb.background ?? "unknown"}", not a photograph — ` +
              `worse, but still a designed thumbnail`,
          },
      );

      // --- platform limits ----------------------------------------------
      // In practice only the tag budget can fire: seo_metadata caps title at
      // 100 and description at 4800, so those two are unreachable while the
      // schema holds. They stay because this is the last checkpoint before an
      // irreversible step, and a schema relaxed later would otherwise remove
      // the guarantee silently. Tags genuinely can exceed — 15 items of 40
      // characters is schema-legal and 100 over YouTube's 500 aggregate.
      const title = seo.title ?? "";
      const description = seo.description ?? "";
      const tagChars = (seo.tags ?? []).reduce((n, t) => n + t.length, 0);
      const limitProblems: string[] = [];
      if (title.length > 100) limitProblems.push(`title ${title.length}/100 chars`);
      if (description.length > 5000) limitProblems.push(`description ${description.length}/5000`);
      if (tagChars > 500) limitProblems.push(`tags ${tagChars}/500 chars`);
      checks.push(
        limitProblems.length === 0
          ? { id: "metadata_limits", status: "pass", message: "title, description and tags fit" }
          : {
            id: "metadata_limits",
            status: "fail",
            message: `YouTube would reject this upload: ${limitProblems.join("; ")}`,
          },
      );

      const failed = checks.filter((c) => c.status === "fail").length;
      const warned = checks.filter((c) => c.status === "warn").length;
      const verdict = failed > 0 ? "fail" : "pass";

      for (const c of checks.filter((c) => c.status !== "pass")) {
        const log = c.status === "fail" ? ctx.logger.error : ctx.logger.warn;
        log(`[qa] ${c.status.toUpperCase()} ${c.id}: ${c.message}`);
      }
      await ctx.progress({ detail: `qa ${verdict}: ${failed} failed, ${warned} warned` });

      return {
        payload: {
          verdict,
          failed,
          warned,
          checks: checks.map((c) => ({
            id: c.id,
            status: c.status,
            message: c.message,
            ...(c.measured !== undefined ? { measured: c.measured } : {}),
            ...(c.threshold !== undefined ? { threshold: c.threshold } : {}),
          })),
        },
      };
    },
  };
}
