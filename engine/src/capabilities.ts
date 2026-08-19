/**
 * What this deployment can actually do, right now, with the keys it has.
 *
 * One declaration, three consumers: `service.rebuild()` picks providers from
 * it, the UI and startup banner report from it, and a test asserts every key
 * named here is settable in the UI.
 *
 * That last point is the reason this file exists. Provider selection and the
 * credential list used to be written out twice, by hand, in two files. When Fal
 * was swapped for stock images only one copy was updated, so the UI went on
 * offering a dead `FAL_KEY` while silently refusing to save `PEXELS_API_KEY` —
 * the key the pipeline had started depending on. Deriving both from one list
 * makes that particular mistake unrepresentable.
 */

export interface StageSpec {
  id: string;
  label: string;
  /**
   * Credential groups. The stage is satisfied when *any one* group has *all*
   * its keys set — "PEXELS or UNSPLASH", but "CLIENT_ID and SECRET and
   * REFRESH_TOKEN" together.
   */
  requires: string[][];
  /** Keys that improve the stage but are not needed to enable it. */
  optional?: string[];
  /** Provider used when satisfied. */
  real: string;
  /** Provider used when not. */
  fallback: string;
  /** What you actually get when it falls back — written for a human. */
  consequence: string;
  /** A non-credential switch that must also be on. */
  gatedBy?: { flag: "allowPublish"; label: string; why: string };
}

export const STAGES: StageSpec[] = [
  {
    id: "reasoning",
    label: "Story, script and visual plan",
    requires: [["ANTHROPIC_API_KEY"]],
    // claude-sonnet-5, not opus - reasoning_high is temporarily downgraded to
    // cut spend (see service.ts's ProviderRouter). Keep this in sync with it.
    real: "anthropic/claude-sonnet-5",
    fallback: "unavailable",
    consequence: "runs fail at the first node — there is no offline fallback for reasoning",
  },
  {
    id: "speech",
    label: "Voiceover",
    requires: [["ELEVENLABS_API_KEY"]],
    optional: ["ELEVENLABS_VOICE_ID"],
    real: "elevenlabs",
    fallback: "fake",
    consequence: "silent placeholder audio; the video renders but has no narration",
  },
  {
    id: "images",
    label: "Scene images",
    // Pixabay is only ever a third fallback inside the provider, so it cannot
    // enable the stage on its own.
    requires: [["PEXELS_API_KEY"], ["UNSPLASH_ACCESS_KEY"]],
    optional: ["PIXABAY_API_KEY"],
    real: "stock (pexels → unsplash → pixabay)",
    fallback: "fake",
    consequence: "solid-colour placeholder images instead of stock photography",
  },
  {
    id: "renderer",
    label: "Video assembly",
    requires: [["COMPOSE_URL"]],
    real: "long-compose",
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
    // Same credentials as publishing, but NOT the same grant: analytics needs
    // the yt-analytics.readonly scope, which the upload scopes do not imply.
    // A refresh token minted before that scope was requested authenticates
    // fine and then 403s, so credentials being present is necessary and not
    // sufficient here.
    requires: [["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]],
    real: "youtube-analytics",
    fallback: "unavailable",
    consequence:
      "no feedback loop — nothing measures whether a published episode worked, " +
      "so titles and thumbnails stay guesses",
  },
];

export interface StageStatus {
  id: string;
  label: string;
  provider: string;
  /** True only when this stage will do the real thing on the next run. */
  real: boolean;
  consequence: string;
  /** Keys that would satisfy the cheapest unmet group. Empty when satisfied. */
  missing: string[];
  /** Set when credentials are present but something else holds the stage back. */
  blockedBy: string | null;
}

function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

/** True when any one required group is fully satisfied. */
export function credentialsSatisfied(
  spec: StageSpec,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return spec.requires.some((group) => group.every((k) => isSet(env, k)));
}

/** The unmet group that is closest to complete — the shortest path to working. */
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

/** Every credential any stage names, required or optional. */
export function credentialKeysUsed(): string[] {
  const keys = new Set<string>();
  for (const s of STAGES) {
    for (const group of s.requires) for (const k of group) keys.add(k);
    for (const k of s.optional ?? []) keys.add(k);
  }
  return [...keys];
}
