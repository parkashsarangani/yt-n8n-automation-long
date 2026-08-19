/**
 * What this deployment can actually do, right now, with the keys it has.
 *
 * One declaration, three consumers: `service.rebuild()` picks providers from
 * it, the UI/startup banner reports from it, and tests assert every key named
 * here is settable in the UI.
 */

export interface StageSpec {
  id: string;
  label: string;
  requires: string[][];
  optional?: string[];
  real: string;
  fallback: string;
  consequence: string;
  gatedBy?: { flag: "allowPublish"; label: string; why: string };
}

export const STAGES: StageSpec[] = [
  {
    id: "reasoning",
    label: "Story, dialogue, visual direction and thumbnail planning",
    requires: [["ANTHROPIC_API_KEY"]],
    real: "anthropic/claude-sonnet-5",
    fallback: "unavailable",
    consequence: "runs fail at the first reasoning node — there is no offline fallback for creative planning",
  },
  {
    id: "speech",
    label: "Character voices",
    requires: [["ELEVENLABS_API_KEY"]],
    optional: ["ELEVENLABS_VOICE_ID"],
    real: "elevenlabs",
    fallback: "fake",
    consequence: "silent placeholder audio; the video renders but has no usable dialogue",
  },
  {
    id: "images",
    label: "Generated cartoon thumbnail artwork",
    requires: [["FAL_KEY"]],
    real: "fal/flux-2-pro",
    fallback: "fake",
    consequence:
      "cartoon scene rendering itself doesn't need this (SVG rigs/backgrounds only spend here for thumbnail " +
      "artwork), but the legacy manual-script path (graphs/manual.json) still calls this provider for scene " +
      "images and silently renders flat placeholder stills without it. Legacy PEXELS_API_KEY/UNSPLASH_ACCESS_KEY " +
      "do not satisfy this stage - only FAL_KEY does.",
  },
  {
    id: "cast",
    label: "Recurring cast configuration",
    requires: [["CARTOON_CAST_PATH"]],
    real: "cast_roster file",
    fallback: "unavailable",
    consequence:
      "the production graph's cast_roster node (cast_loader) throws immediately and the run fails before any " +
      "content is produced - there is no fallback cast",
  },
  {
    id: "renderer",
    label: "Cartoon video assembly",
    requires: [["COMPOSE_URL"]],
    real: "long-compose/remotion+ffmpeg",
    fallback: "fake",
    consequence: "a few placeholder bytes instead of an actual .mp4",
  },
  {
    id: "publish",
    label: "YouTube upload",
    requires: [
      ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
      ["YOUTUBE_ACCESS_TOKEN"],
    ],
    real: "youtube",
    fallback: "dry-run",
    consequence: "the run completes and reports success without uploading anything",
    gatedBy: {
      flag: "allowPublish",
      label: "AMOS_ALLOW_PUBLISH",
      why: "a token alone must never cause an upload",
    },
  },
  {
    id: "analytics",
    label: "Performance measurement",
    requires: [["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]],
    real: "youtube-analytics",
    fallback: "unavailable",
    consequence:
      "no feedback loop — nothing measures whether a published episode worked, " +
      "so packaging and topic decisions stay guesses",
  },
];

export interface StageStatus {
  id: string;
  label: string;
  provider: string;
  real: boolean;
  consequence: string;
  missing: string[];
  blockedBy: string | null;
}

function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

export function credentialsSatisfied(
  spec: StageSpec,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return spec.requires.some((group) => group.every((k) => isSet(env, k)));
}

function nearestMissing(spec: StageSpec, env: NodeJS.ProcessEnv): string[] {
  return spec.requires
    .map((group) => group.filter((k) => !isSet(env, k)))
    .sort((a, b) => a.length - b.length)[0] ?? [];
}

export function capabilityReport(opts: {
  allowPublish: boolean;
  env?: NodeJS.ProcessEnv;
}): StageStatus[] {
  const env = opts.env ?? process.env;

  return STAGES.map((spec) => {
    const hasCreds = credentialsSatisfied(spec, env);
    const gateOpen = spec.gatedBy ? opts.allowPublish : true;
    const real = hasCreds && gateOpen;

    return {
      id: spec.id,
      label: spec.label,
      provider: real ? spec.real : spec.fallback,
      real,
      consequence: spec.consequence,
      missing: hasCreds ? [] : nearestMissing(spec, env),
      blockedBy:
        hasCreds && !gateOpen && spec.gatedBy
          ? `${spec.gatedBy.label} is off — ${spec.gatedBy.why}`
          : null,
    };
  });
}

export function credentialKeysUsed(): string[] {
  const keys = new Set<string>();
  for (const s of STAGES) {
    for (const group of s.requires) for (const k of group) keys.add(k);
    for (const k of s.optional ?? []) keys.add(k);
  }
  return [...keys];
}
