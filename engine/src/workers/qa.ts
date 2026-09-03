/**
 * QA worker: deterministic integrity + budget measurements against the
 * finished script/assets/voice/render/thumbnail/seo artifacts. Non-blocking
 * by convention (RFC 0008: nothing downstream of the watchability gate
 * blocks) -- every graph's approve_publish gate auto-passes regardless of
 * this worker's verdict; it exists so a bad run is visible, not to stop one.
 */
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface QaWorkerOptions {
  maxPlaceholderRatio?: number;
  maxDurationDrift?: number;
  maxScriptDrift?: number;
  wordsPerMinute?: number;
  version?: string;
  name?: string;
}
type Status = "pass" | "warn" | "fail";
interface Check { id: string; status: Status; message: string; measured?: number | null; threshold?: number | null }
interface Intent { target_duration_sec?: number }
interface ScriptScene { scene_index: number; narration?: string }
interface Script { scenes?: ScriptScene[]; word_count?: number }
interface AssetScene { scene_index?: number; source?: string }
interface Assets { scenes?: AssetScene[]; degraded_count?: number }
interface VoiceClip { scene_index?: number; duration_sec?: number }
interface Voice { clips?: VoiceClip[]; total_duration_sec?: number }
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
    name: opts.name ?? "qa",
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
      const visualScenes = [...(assets.scenes ?? [])].sort((a, b) => (a.scene_index ?? 0) - (b.scene_index ?? 0));

      // Two distinct signals, deliberately not blended into one: a bare
      // placeholder scene has NO image at all -- it renders as a black
      // screen for its whole duration (long-compose falls back to a generic
      // dark backdrop never meant to stand alone). A "fallback" scene reused
      // the episode's own reference image instead -- a repeated shot, still
      // real content, not blank. Real production evidence: an episode with
      // 1 blank scene and 2 repeated-shot scenes (3/27, 11%) published
      // publicly because the combined ratio crossed a threshold that treated
      // both the same way. Any blank scene is now always a hard fail
      // (approve_publish's auto-pass predicate holds the episode for review
      // or a targeted retry, see VidGenService.driveUnattended) regardless of
      // how small a fraction of the episode it is; a repeated shot alone
      // stays a ratio-based warn, matching the original PR #209 design
      // decision that a reused shot reads as an intentional callback, not a
      // defect.
      const blankScenes = visualScenes.filter((s) => s.source === "placeholder").length;
      checks.push(blankScenes === 0
        ? { id: "blank_scenes", status: "pass", message: "every scene has a real rendered image, not a blank placeholder" }
        : { id: "blank_scenes", status: "fail", message: `${blankScenes} of ${sceneCount} scene(s) are blank placeholders with no image at all`, measured: blankScenes, threshold: 0 });

      const fallbackScenes = Math.max(0, (assets.degraded_count ?? blankScenes) - blankScenes);
      const fallbackRatio = sceneCount > 0 ? fallbackScenes / sceneCount : 0;
      checks.push(fallbackScenes === 0
        ? { id: "visual_assets_renderable", status: "pass", message: "every scene has a renderable visual asset" }
        : fallbackRatio <= maxPlaceholderRatio
          ? { id: "visual_assets_renderable", status: "warn", message: `${fallbackScenes} of ${sceneCount} scenes reused the episode's reference image instead of their own`, measured: fallbackRatio, threshold: maxPlaceholderRatio }
          : { id: "visual_assets_renderable", status: "fail", message: `${fallbackScenes} of ${sceneCount} scenes reused the episode's reference image instead of their own (${pct(fallbackRatio)}) — the visual asset pipeline is degraded`, measured: fallbackRatio, threshold: maxPlaceholderRatio });

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
