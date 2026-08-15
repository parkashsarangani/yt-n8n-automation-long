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
interface Assets { scenes?: Array<{ source?: string }>; degraded_count?: number }
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

  return {
    name: "qa",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [
      { schema_id: "intent", range: "^1", as: "intent" },
      { schema_id: "script", range: "^1", as: "script" },
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
      const assets = inputs["assets"]!.payload as Assets;
      const voice = inputs["voice"]!.payload as Voice;
      const render = inputs["render"]!.payload as Rendered;
      const thumb = inputs["thumbnail"]!.payload as Thumb;
      const seo = inputs["seo"]!.payload as Seo;

      const checks: Check[] = [];
      const sceneCount = script.scenes?.length ?? 0;
      const targetSec = intent.target_duration_sec ?? 0;

      // --- images actually resolved -------------------------------------
      // The most expensive silent failure: the video renders fine and is
      // entirely solid-colour placeholders.
      const placeholders =
        assets.degraded_count ??
        (assets.scenes ?? []).filter((s) => s.source === "placeholder").length;
      const ratio = sceneCount > 0 ? placeholders / sceneCount : 0;
      checks.push(
        placeholders === 0
          ? { id: "images_resolved", status: "pass", message: "every scene got a real image" }
          : ratio <= maxPlaceholderRatio
            ? {
              id: "images_resolved",
              status: "warn",
              message: `${placeholders} of ${sceneCount} scenes fell back to a placeholder`,
              measured: ratio,
              threshold: maxPlaceholderRatio,
            }
            : {
              id: "images_resolved",
              status: "fail",
              message:
                `${placeholders} of ${sceneCount} scenes are placeholders (${pct(ratio)}) — ` +
                `the stock lookup is failing, not the odd scene`,
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
