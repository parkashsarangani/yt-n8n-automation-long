/**
 * Voice worker: script -> voice.
 *
 * A worker, not an agent — it makes no judgment calls, it calls a TTS service
 * once per scene and stores the bytes. Same input always produces the same
 * artifact (given a deterministic provider).
 *
 * Carries forward the one hard-won lesson from the long-form pipeline: pass the
 * neighbouring narration as context so providers that support it can preserve
 * prosody across separate clips instead of resetting at every scene boundary.
 */

import type { BlobRef } from "../artifact.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import type { SpeechProvider } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";
import { trimMp3ToSpeechWindow } from "../audio/speech-trim.ts";

export interface VoiceWorkerOptions {
  voiceId: string;
  /** ElevenLabs does not allow concurrent requests to the same voice. */
  concurrency?: number;
  version?: string;
}

interface ScriptScene {
  scene_index: number;
  narration: string;
}

type SpeechResult = Awaited<ReturnType<SpeechProvider["synthesize"]>>;

function effectiveVoiceId(speech: SpeechProvider, configuredVoiceId: string): string {
  if (speech.id.startsWith("freellmapi-speech/")) {
    return process.env["FREELLMAPI_SPEECH_VOICE"]?.trim() || "onyx";
  }
  return configuredVoiceId;
}

async function trimProductionSpeech(
  speech: SpeechProvider,
  result: SpeechResult,
  ctx: WorkerContext,
): Promise<SpeechResult> {
  // Fake providers intentionally emit tiny non-media fixtures. Only normalize
  // the real ElevenLabs MP3 path; FreeLLM experimental TTS has no alignment.
  if (!speech.id.startsWith("elevenlabs/") || result.media_type !== "audio/mpeg" || result.alignment === undefined) {
    return result;
  }
  try {
    const trimmed = await trimMp3ToSpeechWindow(result.audio, result.alignment);
    if (!trimmed) return result;
    return {
      ...result,
      audio: trimmed.audio,
      alignment: trimmed.alignment,
      duration_sec: trimmed.duration_sec,
    };
  } catch (error) {
    // Trimming is quality normalization, not a reason to discard otherwise
    // valid speech. Production images ship FFmpeg, but preserve the original
    // clip if a one-off decode fails and make that degradation visible.
    ctx.logger.warn(`[voice] speech-boundary trim failed (${String(error)}); keeping provider audio`);
    return result;
  }
}

export function makeVoiceWorker(opts: VoiceWorkerOptions): WorkerDef {
  return {
    name: "voice",
    kind: "worker",
    version: opts.version ?? "2",
    consumes: [{ schema_id: "script", range: "^1", as: "script" }],
    produces: "voice",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const speech = ctx.media.speech;
      if (!speech) {
        throw new Error('voice worker requires a speech provider (media.speech)');
      }

      const voiceId = effectiveVoiceId(speech, opts.voiceId);
      const scenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);
      const blobs: BlobRef[] = [];

      const clips = await mapWithConcurrency(
        ordered,
        opts.concurrency ?? 1,
        async (scene, i) => {
          let result = await speech.synthesize({
            text: scene.narration,
            voice: voiceId,
            context: {
              ...(i > 0 ? { prev: ordered[i - 1]!.narration } : {}),
              ...(i < ordered.length - 1 ? { next: ordered[i + 1]!.narration } : {}),
            },
          });
          result = await trimProductionSpeech(speech, result, ctx);

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
        voice_id: voiceId,
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
