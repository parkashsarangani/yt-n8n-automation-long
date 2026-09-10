/**
 * What this deployment can actually do, right now, with the keys it has.
 *
 * One declaration, three consumers: service provider selection, UI/startup
 * capability reporting, and credential coverage tests.
 */

import { resolveTextModels } from "./llm-routing.ts";

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
    label: "Story, narration and thumbnail planning",
    requires: [["FREELLMAPI_API_KEY"], ["OPENAI_API_KEY"]],
    optional: [
      "LLM_ROUTER_MODE",
      "LLM_ROUTER_TIMEOUT_MS",
      "FREELLMAPI_BASE_URL",
      "FREELLMAPI_TEXT_MODELS",
      "OPENAI_MODEL",
      "PAID_TEXT_FALLBACK",
    ],
    real: "freellmapi ordered free-model chain",
    fallback: "unavailable",
    consequence: "runs fail at the first reasoning node — the free-model chain is the only text path, there is no paid fallback",
  },
  {
    id: "speech",
    label: "Narrator voice",
    requires: [["ELEVENLABS_API_KEY"]],
    optional: ["ELEVENLABS_VOICE_ID"],
    real: "elevenlabs",
    fallback: "fake",
    consequence: "silent placeholder audio when no live speech provider is configured",
  },
  {
    id: "images",
    label: "Thumbnail artwork",
    requires: [["FAL_KEY"]],
    optional: ["FAL_MODEL", "FAL_PRICE_PER_IMAGE"],
    real: "fal/${FAL_MODEL:-fal-ai/flux-2}",
    fallback: "generated gradient",
    consequence: "thumbnail text is composited over a generated gradient instead of custom artwork",
  },
  {
    id: "renderer",
    label: "Audio-first video assembly",
    requires: [["COMPOSE_URL"]],
    real: "long-compose/ffmpeg",
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

function reasoningSatisfied(env: NodeJS.ProcessEnv): boolean {
  // `direct` is the explicit manual paid rollback. Default `freellmapi` mode
  // has no paid fallback, so it needs the free key and nothing else.
  return routerMode(env) === "direct"
    ? isSet(env, "OPENAI_API_KEY")
    : isSet(env, "FREELLMAPI_API_KEY");
}

function speechSatisfied(env: NodeJS.ProcessEnv): boolean {
  return isSet(env, "ELEVENLABS_API_KEY");
}

export function credentialsSatisfied(spec: StageSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  if (spec.id === "reasoning") return reasoningSatisfied(env);
  if (spec.id === "speech") return speechSatisfied(env);
  return spec.requires.some((group) => group.every((k) => isSet(env, k)));
}

function nearestMissing(spec: StageSpec, env: NodeJS.ProcessEnv): string[] {
  if (spec.id === "reasoning") {
    if (routerMode(env) === "direct") return isSet(env, "OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"];
    if (!isSet(env, "FREELLMAPI_API_KEY")) return ["FREELLMAPI_API_KEY"];
  }
  if (spec.id === "speech") {
    return isSet(env, "ELEVENLABS_API_KEY") ? [] : ["ELEVENLABS_API_KEY"];
  }
  return spec.requires
    .map((group) => group.filter((k) => !isSet(env, k)))
    .sort((a, b) => a.length - b.length)[0] ?? [];
}

function reasoningProvider(env: NodeJS.ProcessEnv): string {
  const openaiModel = env["OPENAI_MODEL"]?.trim() || "gpt-5.6-luna";
  if (routerMode(env) === "direct") return `openai/${openaiModel} (manual rollback)`;
  let chain: string[];
  try {
    chain = resolveTextModels(env);
  } catch {
    chain = ["<invalid FREELLMAPI_TEXT_MODELS>"];
  }
  const head = chain.slice(0, 3).join(", ") + (chain.length > 3 ? `, +${chain.length - 3}` : "");
  return isSet(env, "FREELLMAPI_API_KEY")
    ? `freellmapi free chain [${head}]`
    : `freellmapi free chain [${head}] (FREELLMAPI_API_KEY unset - reasoning unavailable)`;
}

function speechProvider(env: NodeJS.ProcessEnv): string {
  return "elevenlabs";
}

function imageProvider(env: NodeJS.ProcessEnv): string {
  const model = env["FAL_MODEL"]?.trim() || "fal-ai/flux-2";
  return `fal/${model}`;
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
    else provider = spec.real;

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
