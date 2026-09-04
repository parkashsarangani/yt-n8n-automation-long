/** Deterministic technical QA for illustrated episodes. RFC 0009 adds sequence-review visibility while retaining v1 manifest compatibility. */
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
export interface QaWorkerOptions { maxPlaceholderRatio?: number; maxDurationDrift?: number; maxScriptDrift?: number; wordsPerMinute?: number; version?: string; name?: string }
type Status = "pass" | "warn" | "fail";
interface Check { id: string; status: Status; message: string; measured?: number | null; threshold?: number | null }
interface Intent { target_duration_sec?: number }
interface Script { scenes?: Array<{ scene_index: number; narration?: string }>; word_count?: number }
interface VisualReview { status?: string; reviewed_shots?: number; remaining_flagged_shots?: string[]; reason?: string; scores?: Record<string, number> }
interface Assets { scenes?: Array<{ scene_index?: number; source?: string }>; degraded_count?: number; visual_review?: VisualReview }
interface Voice { clips?: Array<{ scene_index?: number; duration_sec?: number }>; total_duration_sec?: number }
interface Rendered { duration_sec?: number; scene_count?: number; degraded_scenes?: number }
interface Thumb { background?: string; text?: string }
interface Seo { title?: string; description?: string; tags?: string[] }
const pct = (n: number) => `${Math.round(n * 100)}%`;
const VISUAL_REVIEW_WARN_FLOOR = 0.68;

export function makeQaWorker(opts: QaWorkerOptions = {}): WorkerDef {
  const maxPlaceholderRatio = opts.maxPlaceholderRatio ?? 0.1;
  const maxDurationDrift = opts.maxDurationDrift ?? 0.25;
  const maxScriptDrift = opts.maxScriptDrift ?? 0.3;
  const wpm = opts.wordsPerMinute ?? 150;
  return {
    name: opts.name ?? "qa", kind: "worker", version: opts.version ?? "2",
    consumes: [
      { schema_id: "intent", range: "^1", as: "intent" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "asset_manifest", range: ">=1 <3", as: "assets" },
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

      const blankScenes = visualScenes.filter((s) => s.source === "placeholder").length;
      checks.push(blankScenes === 0
        ? { id: "blank_scenes", status: "pass", message: "every scene has a real rendered image" }
        : { id: "blank_scenes", status: "fail", message: `${blankScenes} of ${sceneCount} scene(s) are blank placeholders`, measured: blankScenes, threshold: 0 });

      const fallbackScenes = Math.max(0, (assets.degraded_count ?? blankScenes) - blankScenes);
      const fallbackRatio = sceneCount > 0 ? fallbackScenes / sceneCount : 0;
      checks.push(fallbackScenes === 0
        ? { id: "visual_assets_renderable", status: "pass", message: "every scene has a renderable intended visual" }
        : fallbackRatio <= maxPlaceholderRatio
          ? { id: "visual_assets_renderable", status: "warn", message: `${fallbackScenes} of ${sceneCount} scenes contain fallback imagery`, measured: fallbackRatio, threshold: maxPlaceholderRatio }
          : { id: "visual_assets_renderable", status: "fail", message: `${fallbackScenes} of ${sceneCount} scenes contain fallback imagery (${pct(fallbackRatio)})`, measured: fallbackRatio, threshold: maxPlaceholderRatio });

      if (assets.visual_review) {
        const remaining = assets.visual_review.remaining_flagged_shots?.length ?? 0;
        const numericScores = Object.values(assets.visual_review.scores ?? {}).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const minScore = numericScores.length ? Math.min(...numericScores) : null;
        if (assets.visual_review.status === "unavailable") {
          checks.push({ id: "episode_visual_review", status: "warn", message: assets.visual_review.reason || "episode-level multimodal visual review unavailable" });
        } else if (remaining > 0) {
          checks.push({ id: "episode_visual_review", status: "warn", message: `${remaining} shot(s) remain flagged after targeted regeneration: ${assets.visual_review.remaining_flagged_shots!.join(", ")}`, measured: remaining, threshold: 0 });
        } else if (assets.visual_review.status === "warn" || (minScore !== null && minScore < VISUAL_REVIEW_WARN_FLOOR)) {
          checks.push({
            id: "episode_visual_review",
            status: "warn",
            message: assets.visual_review.reason || `episode-level visual review minimum score ${minScore?.toFixed(2)} remains below ${VISUAL_REVIEW_WARN_FLOOR.toFixed(2)}`,
            ...(minScore !== null ? { measured: minScore, threshold: VISUAL_REVIEW_WARN_FLOOR } : {}),
          });
        } else {
          checks.push({ id: "episode_visual_review", status: "pass", message: `episode-level visual review passed across ${assets.visual_review.reviewed_shots ?? 0} shots` });
        }
      }

      const clips = voice.clips?.length ?? 0;
      checks.push(clips === sceneCount
        ? { id: "narration_complete", status: "pass", message: `${clips} clips for ${sceneCount} scenes` }
        : { id: "narration_complete", status: "fail", message: `${clips} voice clips for ${sceneCount} scenes`, measured: clips, threshold: sceneCount });
      const rendered = render.scene_count ?? 0;
      checks.push(rendered === sceneCount
        ? { id: "scenes_rendered", status: "pass", message: `all ${sceneCount} scenes rendered` }
        : { id: "scenes_rendered", status: "fail", message: `renderer reported ${rendered} scenes, the script has ${sceneCount}`, measured: rendered, threshold: sceneCount });

      if (targetSec > 0 && typeof render.duration_sec === "number") {
        const drift = Math.abs(render.duration_sec - targetSec) / targetSec;
        checks.push(drift <= maxDurationDrift
          ? { id: "duration", status: "pass", message: `${Math.round(render.duration_sec)}s against a ${targetSec}s target`, measured: drift, threshold: maxDurationDrift }
          : { id: "duration", status: "fail", message: `${Math.round(render.duration_sec)}s against a ${targetSec}s target (${pct(drift)} off)`, measured: drift, threshold: maxDurationDrift });
      } else checks.push({ id: "duration", status: "warn", message: "no rendered duration reported", measured: null });

      if (targetSec > 0 && typeof script.word_count === "number" && script.word_count > 0) {
        const budget = (targetSec / 60) * wpm;
        const drift = Math.abs(script.word_count - budget) / budget;
        checks.push({ id: "script_length", status: drift <= maxScriptDrift ? "pass" : "warn", message: `${script.word_count} words against ~${Math.round(budget)}`, measured: drift, threshold: maxScriptDrift });
      }
      checks.push(thumb.background === "supplied"
        ? { id: "thumbnail_image", status: "pass", message: "thumbnail uses a supplied image" }
        : { id: "thumbnail_image", status: "warn", message: `thumbnail background is ${thumb.background ?? "unknown"}` });

      const title = seo.title ?? "";
      const description = seo.description ?? "";
      const tagChars = (seo.tags ?? []).reduce((n, t) => n + t.length, 0);
      const problems: string[] = [];
      if (title.length > 100) problems.push(`title ${title.length}/100 chars`);
      if (description.length > 5000) problems.push(`description ${description.length}/5000`);
      if (tagChars > 500) problems.push(`tags ${tagChars}/500 chars`);
      checks.push(problems.length === 0
        ? { id: "metadata_limits", status: "pass", message: "title, description and tags fit" }
        : { id: "metadata_limits", status: "fail", message: `YouTube would reject: ${problems.join("; ")}` });

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
