/**
 * What this deployment can actually do, right now, with the keys it has.
 *
 * One declaration, three consumers: service provider selection, UI/startup
 * capability reporting, and credential coverage tests.
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
    label: "Story, dialogue, visual direction, thumbnail planning and visual QA",
    requires: [["FREELLMAPI_API_KEY"], ["OPENAI_API_KEY"]],
    optional: [
      "LLM_ROUTER_MODE",
      "LLM_ROUTER_FAIL_OPEN_TO_DIRECT",
      "LLM_ROUTER_TIMEOUT_MS",
      "FREELLMAPI_BASE_URL",
      "FREELLMAPI_TEXT_MODEL",
      "FREELLMAPI_VISION_MODEL",
      "OPENAI_MODEL",
    ],
    real: "freellmapi/${FREELLMAPI_TEXT_MODEL:-auto:smart}",
    fallback: "unavailable",
    consequence: "runs fail at the first reasoning node — there is no offline model fallback for creative planning",
  },
  {
    id: "speech",
    label: "Narrator voice",
    requires: [["FREELLMAPI_API_KEY"], ["ELEVENLABS_API_KEY"]],
    optional: [
      "SPEECH_PROVIDER_MODE",
      "FREELLMAPI_BASE_URL",
      "FREELLMAPI_SPEECH_MODEL",
      "FREELLMAPI_SPEECH_VOICE",
      "FREELLMAPI_SPEECH_FORMAT",
      "FREELLMAPI_MEDIA_TIMEOUT_MS",
      "ELEVENLABS_VOICE_ID",
    ],
    real: "freellmapi-speech/${FREELLMAPI_SPEECH_MODEL:-auto}",
    fallback: "fake",
    consequence: "silent placeholder audio; set SPEECH_PROVIDER_MODE=elevenlabs to roll back to ElevenLabs",
  },
  {
    id: "images",
    label: "Illustrated stills and thumbnail artwork",
    requires: [["FREELLMAPI_API_KEY"], ["FAL_KEY"]],
    optional: [
      "IMAGE_PROVIDER_MODE",
      "FREELLMAPI_BASE_URL",
      "FREELLMAPI_IMAGE_MODEL",
      "FREELLMAPI_MEDIA_TIMEOUT_MS",
    ],
    real: "freellmapi-image/${FREELLMAPI_IMAGE_MODEL:-auto}",
    fallback: "unavailable",
    consequence:
      "without the selected image provider every scene degrades to a placeholder; set IMAGE_PROVIDER_MODE=fal to restore reference-conditioned FLUX.2 editing",
  },
  {
    id: "renderer",
    label: "Hybrid video assembly",
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
      "no feedback loop — nothing measures whether a published episode worked, so packaging and topic decisions stay guesses",
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

function routerMode(env: NodeJS.ProcessEnv): "freellmapi" | "direct" {
  return env["LLM_ROUTER_MODE"]?.trim().toLowerCase() === "direct" ? "direct" : "freellmapi";
}

function failOpen(env: NodeJS.ProcessEnv): boolean {
  const v = env["LLM_ROUTER_FAIL_OPEN_TO_DIRECT"]?.trim().toLowerCase();
  return v === undefined || !["false", "0", "off", "no"].includes(v);
}

function speechMode(env: NodeJS.ProcessEnv): "freellmapi" | "elevenlabs" {
  return env["SPEECH_PROVIDER_MODE"]?.trim().toLowerCase() === "freellmapi" ? "freellmapi" : "elevenlabs";
}

function imageMode(env: NodeJS.ProcessEnv): "freellmapi" | "fal" {
  return env["IMAGE_PROVIDER_MODE"]?.trim().toLowerCase() === "freellmapi" ? "freellmapi" : "fal";
}

function reasoningSatisfied(env: NodeJS.ProcessEnv): boolean {
  if (routerMode(env) === "direct") return isSet(env, "OPENAI_API_KEY");
  if (isSet(env, "FREELLMAPI_API_KEY")) return true;
  return failOpen(env) && isSet(env, "OPENAI_API_KEY");
}

function speechSatisfied(env: NodeJS.ProcessEnv): boolean {
  return speechMode(env) === "elevenlabs"
    ? isSet(env, "ELEVENLABS_API_KEY")
    : isSet(env, "FREELLMAPI_API_KEY");
}

function imagesSatisfied(env: NodeJS.ProcessEnv): boolean {
  return imageMode(env) === "fal"
    ? isSet(env, "FAL_KEY")
    : isSet(env, "FREELLMAPI_API_KEY");
}

export function credentialsSatisfied(spec: StageSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  if (spec.id === "reasoning") return reasoningSatisfied(env);
  if (spec.id === "speech") return speechSatisfied(env);
  if (spec.id === "images") return imagesSatisfied(env);
  return spec.requires.some((group) => group.every((k) => isSet(env, k)));
}

function nearestMissing(spec: StageSpec, env: NodeJS.ProcessEnv): string[] {
  if (spec.id === "reasoning") {
    if (routerMode(env) === "direct") return isSet(env, "OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"];
    if (!isSet(env, "FREELLMAPI_API_KEY") && !failOpen(env)) return ["FREELLMAPI_API_KEY"];
  }
  if (spec.id === "speech") {
    const key = speechMode(env) === "elevenlabs" ? "ELEVENLABS_API_KEY" : "FREELLMAPI_API_KEY";
    return isSet(env, key) ? [] : [key];
  }
  if (spec.id === "images") {
    const key = imageMode(env) === "fal" ? "FAL_KEY" : "FREELLMAPI_API_KEY";
    return isSet(env, key) ? [] : [key];
  }
  return spec.requires
    .map((group) => group.filter((k) => !isSet(env, k)))
    .sort((a, b) => a.length - b.length)[0] ?? [];
}

function reasoningProvider(env: NodeJS.ProcessEnv): string {
  const openaiModel = env["OPENAI_MODEL"]?.trim() || "gpt-5.6-luna";
  if (routerMode(env) === "direct") return `openai/${openaiModel}`;
  if (isSet(env, "FREELLMAPI_API_KEY")) {
    const freeModel = env["FREELLMAPI_TEXT_MODEL"]?.trim() || "auto:smart";
    return failOpen(env) && isSet(env, "OPENAI_API_KEY")
      ? `freellmapi/${freeModel} → openai/${openaiModel} fail-open`
      : `freellmapi/${freeModel}`;
  }
  return `openai/${openaiModel} (FreeLLMAPI unconfigured; fail-open)`;
}

function speechProvider(env: NodeJS.ProcessEnv): string {
  if (speechMode(env) === "elevenlabs") return "elevenlabs";
  return `freellmapi/${env["FREELLMAPI_SPEECH_MODEL"]?.trim() || "auto"}`;
}

function imageProvider(env: NodeJS.ProcessEnv): string {
  if (imageMode(env) === "fal") return "fal/flux-2 + flux-2/edit";
  return `freellmapi/${env["FREELLMAPI_IMAGE_MODEL"]?.trim() || "auto"} (text-to-image; no reference edit)`;
}

export function capabilityReport(opts: { allowPublish: boolean; env?: NodeJS.ProcessEnv }): StageStatus[] {
  const env = opts.env ?? process.env;
  return STAGES.map((spec) => {
    const hasCreds = credentialsSatisfied(spec, env);
    const gateOpen = spec.gatedBy ? opts.allowPublish : true;
    const real = hasCreds && gateOpen;
    let provider: string;
    if (!real) provider = spec.fallback;
    else if (spec.id === "reasoning") provider = reasoningProvider(env);
    else if (spec.id === "speech") provider = speechProvider(env);
    else if (spec.id === "images") provider = imageProvider(env);
    else provider = spec.real.replace("${OPENAI_MODEL:-gpt-5.6-luna}", env["OPENAI_MODEL"]?.trim() || "gpt-5.6-luna");

    return {
      id: spec.id,
      label: spec.label,
      provider,
      real,
      consequence: spec.consequence,
      missing: hasCreds ? [] : nearestMissing(spec, env),
      blockedBy: hasCreds && !gateOpen && spec.gatedBy
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
