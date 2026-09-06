import { createHash } from "node:crypto";

import { mapWithConcurrency } from "../concurrency.ts";
import {
  DEFAULT_MODERATION_MODEL,
  TTS_POLICY_VERSION,
  decideTtsScene,
  moderateTextWithOpenAI,
  type TtsModerationDecision,
} from "../moderation/tts-policy.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface TtsModerationWorkerOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  version?: string;
}

interface ScriptScene {
  scene_index: number;
  narration: string;
}

interface ScriptPayload {
  scenes: ScriptScene[];
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217)}...`;
}

function overallDecision(decisions: TtsModerationDecision[]): TtsModerationDecision {
  if (decisions.includes("block")) return "block";
  if (decisions.includes("review")) return "review";
  return "allow";
}

export function makeTtsModerationWorker(opts: TtsModerationWorkerOptions = {}): WorkerDef {
  return {
    name: "tts_moderation",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [{ schema_id: "script", range: "^1", as: "script" }],
    produces: "tts_moderation_report",
    produces_version: "1.0.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const apiKey = clean(opts.apiKey) ?? clean(process.env["OPENAI_API_KEY"]);
      if (!apiKey) {
        throw new Error("tts_moderation requires OPENAI_API_KEY; moderation must fail closed before TTS");
      }
      const model = clean(opts.model) ?? clean(process.env["OPENAI_MODERATION_MODEL"]) ?? DEFAULT_MODERATION_MODEL;
      const baseUrl = clean(opts.baseUrl) ?? clean(process.env["OPENAI_BASE_URL"]);
      const timeoutMs = opts.timeoutMs ?? Number(process.env["TTS_MODERATION_TIMEOUT_MS"] || 30_000);
      const scriptArtifact = inputs["script"]!;
      const script = scriptArtifact.payload as ScriptPayload;
      const ordered = [...script.scenes].sort((a, b) => a.scene_index - b.scene_index);
      if (!ordered.length) throw new Error("tts_moderation: script contains no scenes");

      const scenes = await mapWithConcurrency(
        ordered,
        Math.max(1, opts.concurrency ?? 3),
        async (scene, index) => {
          const moderation = await moderateTextWithOpenAI(scene.narration, {
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          });
          const policy = decideTtsScene(moderation, scene.narration);
          await ctx.progress({
            detail: `pre-TTS moderation ${index + 1}/${ordered.length}: scene ${scene.scene_index} -> ${policy.decision}`,
          });
          return {
            scene_index: scene.scene_index,
            narration_sha256: sha256(scene.narration),
            narration_excerpt: excerpt(scene.narration),
            request_id: moderation.request_id,
            flagged: moderation.flagged,
            decision: policy.decision,
            categories: moderation.categories,
            elevenlabs_signals: policy.signals,
            reasons: policy.reasons,
            _model: moderation.model,
          };
        },
      );

      const decisions = scenes.map((scene) => scene.decision);
      const decision = overallDecision(decisions);
      const reasons = scenes.flatMap((scene) => scene.reasons.map((reason) => `scene ${scene.scene_index}: ${reason}`));
      const models = [...new Set(scenes.map((scene) => scene._model))];
      const payloadScenes = scenes.map(({ _model, ...scene }) => {
        void _model;
        return scene;
      });

      return {
        payload: {
          policy_version: TTS_POLICY_VERSION,
          script_artifact_id: scriptArtifact.artifact_id,
          provider: "openai-moderation",
          model: models.length === 1 ? models[0]! : models.join(","),
          decision,
          approved_for_tts: decision === "allow",
          checked_at: new Date().toISOString(),
          scenes: payloadScenes,
          summary: {
            scene_count: scenes.length,
            allow: decisions.filter((value) => value === "allow").length,
            review: decisions.filter((value) => value === "review").length,
            block: decisions.filter((value) => value === "block").length,
            openai_flagged: scenes.filter((scene) => scene.flagged).length,
            elevenlabs_signal_count: scenes.reduce((sum, scene) => sum + scene.elevenlabs_signals.length, 0),
          },
          reasons,
        },
      };
    },
  };
}
