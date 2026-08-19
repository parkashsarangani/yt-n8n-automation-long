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
  /** ElevenLabs does not allow concurrent requests to the same voice. */
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
        opts.concurrency ?? 1,
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

/**
 * Dialogue voice worker: script + cast_roster -> voice.
 *
 * A distinct worker rather than an option on makeVoiceWorker: consumes[]
 * arity is fixed once a transformation is registered, shared by every graph
 * that references it by name. skeleton.json's and manual.json's "voice"
 * nodes only ever supply one input (script) - adding a required cast_roster
 * input to that same worker would break their static graph validation.
 * cartoon.json instead uses this worker under the name "dialogue_voice".
 *
 * Routes each scene's TTS call to its speaker's voice via the cast roster
 * (falling back to the roster's default, then this worker's own default, for
 * any scene without a recognised speaker) - everything else, including the
 * neighbouring-narration context for prosody, is identical to voice.ts.
 */
export interface DialogueVoiceWorkerOptions {
  /** Used for the artifact's required top-level voice_id, and as the last-resort fallback. */
  defaultVoiceId: string;
  /** ElevenLabs does not allow concurrent requests to the same voice. */
  concurrency?: number;
  version?: string;
}

interface CastMember {
  character_id: string;
  voice_id: string;
}
interface CastRosterPayload {
  characters: CastMember[];
  default_voice_id?: string;
}
interface DialogueScriptScene extends ScriptScene {
  speaker?: string;
}

export function makeDialogueVoiceWorker(opts: DialogueVoiceWorkerOptions): WorkerDef {
  return {
    name: "dialogue_voice",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "cast_roster", range: "^1", as: "cast_roster" },
    ],
    produces: "voice",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const speech = ctx.media.speech;
      if (!speech) {
        throw new Error('dialogue_voice worker requires a speech provider (media.speech)');
      }

      const scenes = (inputs["script"]!.payload as { scenes: DialogueScriptScene[] }).scenes;
      const cast = inputs["cast_roster"]!.payload as CastRosterPayload;
      const voiceFor = new Map(cast.characters.map((c) => [c.character_id, c.voice_id]));
      const fallbackVoiceId = cast.default_voice_id ?? opts.defaultVoiceId;

      const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);
      const blobs: BlobRef[] = [];

      const clips = await mapWithConcurrency(
        ordered,
        opts.concurrency ?? 1,
        async (scene, i) => {
          const voiceId = (scene.speaker && voiceFor.get(scene.speaker)) || fallbackVoiceId;
          const result = await speech.synthesize({
            text: scene.narration,
            voice: voiceId,
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
        voice_id: opts.defaultVoiceId,
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
