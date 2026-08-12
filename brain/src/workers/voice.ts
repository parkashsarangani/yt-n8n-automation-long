/**
 * Voice worker: script -> voice.
 *
 * A worker, not an agent — it makes no judgment calls, it calls a TTS service
 * once per scene and stores the bytes. Same input always produces the same
 * artifact (given a deterministic provider).
 *
 * Carries forward the one hard-won lesson from the long-form pipeline: pass the
 * neighbouring narration as context so prosody stays continuous across ~50
 * separate clips instead of resetting at every scene boundary.
 */

import type { BlobRef } from "../artifact.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface VoiceWorkerOptions {
  voiceId: string;
  /** TTS providers rate-limit; long-form is ~50 calls per video. */
  concurrency?: number;
  version?: string;
}

interface ScriptScene {
  scene_index: number;
  narration: string;
}

export function makeVoiceWorker(opts: VoiceWorkerOptions): WorkerDef {
  return {
    name: "voice",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [{ schema_id: "script", range: "^1", as: "script" }],
    produces: "voice",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const speech = ctx.media.speech;
      if (!speech) {
        throw new Error('voice worker requires a speech provider (media.speech)');
      }

      const scenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);
      const blobs: BlobRef[] = [];

      const clips = await mapWithConcurrency(
        ordered,
        opts.concurrency ?? 4,
        async (scene, i) => {
          const result = await speech.synthesize({
            text: scene.narration,
            voice: opts.voiceId,
            context: {
              ...(i > 0 ? { prev: ordered[i - 1]!.narration } : {}),
              ...(i < ordered.length - 1 ? { next: ordered[i + 1]!.narration } : {}),
            },
          });

          const audio = await ctx.blobs.put(result.audio, {
            role: "audio",
            media_type: result.media_type,
          });

          let alignmentRef: BlobRef | null = null;
          if (result.alignment !== undefined) {
            alignmentRef = await ctx.blobs.put(
              new TextEncoder().encode(JSON.stringify(result.alignment)),
              { role: "alignment", media_type: "application/json" },
            );
          }

          return {
            scene_index: scene.scene_index,
            audio_uri: audio.uri,
            ...(alignmentRef ? { alignment_uri: alignmentRef.uri } : {}),
            duration_sec: result.duration_sec ?? 0,
            _blobs: alignmentRef ? [audio, alignmentRef] : [audio],
          };
        },
      );

      for (const c of clips) blobs.push(...c._blobs);

      const payload = {
        voice_id: opts.voiceId,
        clips: clips.map(({ _blobs, ...clip }) => {
          void _blobs;
          return clip;
        }),
        total_duration_sec: Number(
          clips.reduce((sum, c) => sum + c.duration_sec, 0).toFixed(3),
        ),
      };

      return { payload, blobs };
    },
  };
}
