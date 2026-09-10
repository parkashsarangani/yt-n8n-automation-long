/** Deterministic pre-publish QA for the audio-first production graph. */
import { readMp4Geometry } from "../media/mp4.ts";
import type { WorkerDef, WorkerOutput } from "../runner.ts";

export interface QaWorkerOptions { version?: string }

type CheckStatus = "pass" | "warn" | "fail";
interface Check { id: string; status: CheckStatus; message: string; measured?: number | null; threshold?: number | null }
interface ScriptScene { scene_index: number; narration: string }
interface VoiceClip { scene_index: number; audio_uri: string; duration_sec: number }

export function makeQaWorker(opts: QaWorkerOptions = {}): WorkerDef {
  return {
    name: "qa",
    kind: "worker",
    version: opts.version ?? "5",
    consumes: [
      { schema_id: "intent", range: "^2", as: "intent" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "rendered_video", range: "^1", as: "render" },
      { schema_id: "thumbnail", range: "^1", as: "thumbnail" },
      { schema_id: "seo_metadata", range: "^1", as: "seo" },
    ],
    produces: "qa_report",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const checks: Check[] = [];
      const add = (id: string, status: CheckStatus, message: string, measured?: number, threshold?: number) => {
        checks.push({ id, status, message, ...(measured !== undefined ? { measured } : {}), ...(threshold !== undefined ? { threshold } : {}) });
      };

      const script = inputs["script"]!.payload as { scenes?: ScriptScene[] };
      const voice = inputs["voice"]!.payload as { clips?: VoiceClip[]; duration_sec?: number };
      const render = inputs["render"]!.payload as { video_uri?: string; media_type?: string; scene_count?: number; duration_sec?: number; degraded_scenes?: number };
      const thumbnail = inputs["thumbnail"]!.payload as { thumbnail_uri?: string; media_type?: string; width?: number; height?: number; bytes?: number };
      const seo = inputs["seo"]!.payload as { title?: string; description?: string; tags?: string[] };
      const intent = inputs["intent"]!.payload as { target_duration_sec?: number };

      const scenes = Array.isArray(script.scenes) ? script.scenes : [];
      const clips = Array.isArray(voice.clips) ? voice.clips : [];
      add("script_nonempty", scenes.length > 0 ? "pass" : "fail", scenes.length > 0 ? `${scenes.length} approved narration scenes` : "approved script has no scenes", scenes.length, 1);

      const sceneIds = scenes.map((s) => s.scene_index);
      const uniqueSceneIds = new Set(sceneIds);
      const sorted = [...sceneIds].sort((a, b) => a - b);
      const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1]! + 1);
      add("script_scene_indices", uniqueSceneIds.size === scenes.length && contiguous ? "pass" : "fail", uniqueSceneIds.size === scenes.length && contiguous ? "script scene indices are unique and contiguous" : "script scene indices are duplicated or non-contiguous");

      const clipIds = clips.map((c) => c.scene_index);
      const uniqueClipIds = new Set(clipIds);
      const exactVoiceCoverage = clips.length === scenes.length && uniqueClipIds.size === clips.length && scenes.every((s) => uniqueClipIds.has(s.scene_index));
      add("voice_scene_coverage", exactVoiceCoverage ? "pass" : "fail", exactVoiceCoverage ? "exactly one voice clip covers every approved narration scene" : "voice clips do not exactly match approved narration scenes", clips.length, scenes.length);

      const invalidClips = clips.filter((c) => !c.audio_uri?.trim() || !(c.duration_sec > 0));
      add("voice_clip_integrity", invalidClips.length === 0 ? "pass" : "fail", invalidClips.length === 0 ? "all voice clips have audio blobs and positive duration" : `${invalidClips.length} voice clip(s) have missing audio or invalid duration`, invalidClips.length, 0);

      const voiceDuration = clips.reduce((sum, c) => sum + (Number.isFinite(c.duration_sec) ? c.duration_sec : 0), 0);
      add("voice_duration", voiceDuration > 0 ? "pass" : "fail", voiceDuration > 0 ? `voice programme duration ${voiceDuration.toFixed(2)}s` : "voice programme duration is zero", voiceDuration, 0);

      add("render_media_type", render.media_type === "video/mp4" ? "pass" : "fail", render.media_type === "video/mp4" ? "render is video/mp4" : `render media type is ${render.media_type ?? "missing"}`);
      add("render_scene_count", render.scene_count === scenes.length ? "pass" : "fail", render.scene_count === scenes.length ? "render scene count matches approved script" : `render scene count ${render.scene_count ?? "missing"} does not match script ${scenes.length}`, render.scene_count, scenes.length);
      add("render_not_degraded", (render.degraded_scenes ?? 0) === 0 ? "pass" : "fail", (render.degraded_scenes ?? 0) === 0 ? "audio-first render has no degraded scenes" : `render reports ${render.degraded_scenes} degraded scene(s)`, render.degraded_scenes ?? 0, 0);

      if (!render.video_uri) {
        add("render_blob", "fail", "rendered video blob is missing");
      } else {
        try {
          const bytes = await ctx.blobs.get(render.video_uri);
          const geometry = readMp4Geometry(bytes);
          add("render_blob", bytes.length > 0 ? "pass" : "fail", bytes.length > 0 ? `rendered MP4 is ${bytes.length} bytes` : "rendered MP4 is empty", bytes.length, 1);
          add("render_geometry", geometry?.width === 1920 && geometry?.height === 1080 ? "pass" : "fail", geometry ? `render geometry ${geometry.width}x${geometry.height}` : "could not read MP4 display geometry");
        } catch (err) {
          add("render_blob", "fail", `rendered video blob cannot be read: ${String(err)}`);
        }
      }

      if (typeof render.duration_sec === "number" && render.duration_sec > 0 && voiceDuration > 0) {
        const delta = Math.abs(render.duration_sec - voiceDuration);
        const tolerance = Math.max(4, voiceDuration * 0.03);
        add("render_audio_duration", delta <= tolerance ? "pass" : "fail", `render/voice duration delta ${delta.toFixed(2)}s (tolerance ${tolerance.toFixed(2)}s)`, delta, tolerance);
      } else {
        add("render_audio_duration", "warn", "renderer did not report a duration; voice coverage remains authoritative");
      }

      if (typeof intent.target_duration_sec === "number" && intent.target_duration_sec > 0 && voiceDuration > 0) {
        const drift = Math.abs(voiceDuration - intent.target_duration_sec) / intent.target_duration_sec;
        add("target_duration", drift <= 0.15 ? "pass" : "warn", `voice duration is ${(drift * 100).toFixed(1)}% from requested target`, drift, 0.15);
      }

      const thumbOk = !!thumbnail.thumbnail_uri && (thumbnail.media_type === "image/png" || thumbnail.media_type === "image/jpeg") && (thumbnail.width ?? 0) >= 1280 && (thumbnail.height ?? 0) >= 720;
      add("thumbnail_integrity", thumbOk ? "pass" : "fail", thumbOk ? `thumbnail ${thumbnail.width}x${thumbnail.height} ${thumbnail.media_type}` : "thumbnail is missing, undersized, or has an unsupported media type");
      if (typeof thumbnail.bytes === "number") add("thumbnail_size", thumbnail.bytes <= 2 * 1024 * 1024 ? "pass" : "fail", `thumbnail payload ${thumbnail.bytes} bytes`, thumbnail.bytes, 2 * 1024 * 1024);

      const title = seo.title?.trim() ?? "";
      add("seo_title", title.length > 0 && title.length <= 100 ? "pass" : "fail", title.length ? `SEO title is ${title.length} characters` : "SEO title is missing", title.length, 100);
      const description = seo.description ?? "";
      add("seo_description", description.length <= 5000 ? "pass" : "fail", `SEO description is ${description.length} characters`, description.length, 5000);
      const tags = Array.isArray(seo.tags) ? seo.tags : [];
      const tagChars = tags.reduce((sum, tag) => sum + tag.length, 0);
      add("seo_tags", tags.length <= 15 && tagChars <= 500 ? "pass" : "fail", `${tags.length} tags / ${tagChars} total characters`, tagChars, 500);

      const failed = checks.filter((c) => c.status === "fail").length;
      const warned = checks.filter((c) => c.status === "warn").length;
      return { payload: { verdict: failed === 0 ? "pass" : "fail", checks, failed, warned } };
    },
  };
}
