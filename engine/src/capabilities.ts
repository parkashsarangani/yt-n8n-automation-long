/**
 * What this deployment can actually do, right now, with the keys it has.
 *
 * One declaration, three consumers: service provider selection, UI/startup
 * capability reporting, and credential coverage tests.
 */

import { resolveTextModels } from "./llm-routing.ts";
import { freeImageChainReady, resolveFreeImageModels } from "./freellm-media-models.ts";
import { realVisionQaEnabled } from "./visual-qa-mode.ts";

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
    id: "visual_qa",
    label: "Visual QA (text metadata proxy by default; real vision is opt-in)",
    requires: [["FREELLMAPI_API_KEY"], ["OPENAI_API_KEY"]],
    optional: ["VISUAL_QA_MODE", "OPENAI_IMAGE_QA_MODEL", "OPENAI_MODEL", "PAID_VISION_FALLBACK", "FREE_VISION_MODELS"],
    real: "free text semantic proxy (no paid vision) unless VISUAL_QA_MODE=real",
    fallback: "unavailable",
    consequence: "candidate sourcing intent cannot be screened; a real pixel-level benchmark still needs VISUAL_QA_MODE=real + OPENAI_API_KEY",
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
    real: "elevenlabs",
    fallback: "fake",
    consequence: "silent placeholder audio when no live speech provider is configured",
  },
  {
    id: "images",
    label: "Generated visual beats, illustrated stills and thumbnail artwork",
    // Either a fal credential OR a configured free FreeLLMAPI image chain
    // satisfies this stage. With only the free chain, generation is entirely
    // free and there is no paid last resort.
    requires: [["FAL_KEY"], ["FREELLMAPI_API_KEY", "FREELLMAPI_IMAGE_MODELS"]],
    optional: [
      "FAL_MODEL", "FAL_EDIT_MODEL", "FAL_PRICE_PER_IMAGE",
      "PAID_IMAGE_FALLBACK", "PAID_VIDEO_FALLBACK",
      "FREELLMAPI_IMAGE_MODELS", "FREELLMAPI_VIDEO_MODELS", "FREELLMAPI_VIDEO_DURATION_SEC",
    ],
    real: "freellmapi media gateway (free-first) then fal/${FAL_MODEL:-fal-ai/flux-2} when PAID_IMAGE_FALLBACK",
    fallback: "unavailable",
    consequence: "generated-image visual beats cannot be produced (no free FreeLLMAPI image chain and no fal credential)",
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

function speechMode(env: NodeJS.ProcessEnv): "freellmapi" | "elevenlabs" {
  return env["SPEECH_PROVIDER_MODE"]?.trim().toLowerCase() === "freellmapi" ? "freellmapi" : "elevenlabs";
}

function reasoningSatisfied(env: NodeJS.ProcessEnv): boolean {
  // `direct` is the explicit manual paid rollback. Default `freellmapi` mode
  // has no paid fallback, so it needs the free key and nothing else.
  return routerMode(env) === "direct"
    ? isSet(env, "OPENAI_API_KEY")
    : isSet(env, "FREELLMAPI_API_KEY");
}

function speechSatisfied(env: NodeJS.ProcessEnv): boolean {
  return speechMode(env) === "elevenlabs"
    ? isSet(env, "ELEVENLABS_API_KEY")
    : isSet(env, "FREELLMAPI_API_KEY");
}

export function credentialsSatisfied(spec: StageSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  if (spec.id === "reasoning") return reasoningSatisfied(env);
  if (spec.id === "speech") return speechSatisfied(env);
  if (spec.id === "visual_qa") {
    return realVisionQaEnabled(env) ? isSet(env, "OPENAI_API_KEY") : isSet(env, "FREELLMAPI_API_KEY");
  }
  return spec.requires.some((group) => group.every((k) => isSet(env, k)));
}

function nearestMissing(spec: StageSpec, env: NodeJS.ProcessEnv): string[] {
  if (spec.id === "reasoning") {
    if (routerMode(env) === "direct") return isSet(env, "OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"];
    if (!isSet(env, "FREELLMAPI_API_KEY")) return ["FREELLMAPI_API_KEY"];
  }
  if (spec.id === "speech") {
    const key = speechMode(env) === "elevenlabs" ? "ELEVENLABS_API_KEY" : "FREELLMAPI_API_KEY";
    return isSet(env, key) ? [] : [key];
  }
  if (spec.id === "visual_qa") {
    const key = realVisionQaEnabled(env) ? "OPENAI_API_KEY" : "FREELLMAPI_API_KEY";
    return isSet(env, key) ? [] : [key];
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

function visualQaProvider(env: NodeJS.ProcessEnv): string {
  if (realVisionQaEnabled(env)) {
    const model = env["OPENAI_IMAGE_QA_MODEL"]?.trim() || env["OPENAI_MODEL"]?.trim() || "gpt-5.6-luna";
    return `openai/${model} (real vision, opt-in)`;
  }
  return "free text semantic proxy (no paid vision)";
}

function speechProvider(env: NodeJS.ProcessEnv): string {
  if (speechMode(env) === "elevenlabs") return "elevenlabs";
  return `freellmapi/${env["FREELLMAPI_SPEECH_MODEL"]?.trim() || "auto"}`;
}

function imageProvider(env: NodeJS.ProcessEnv): string {
  const model = env["FAL_MODEL"]?.trim() || "fal-ai/flux-2";
  const editModel = env["FAL_EDIT_MODEL"]?.trim() || `${model}/edit`;
  const hasFal = isSet(env, "FAL_KEY");
  const paidImage = /^(1|true|yes|on)$/i.test((env["PAID_IMAGE_FALLBACK"] ?? "true").trim());
  // Free chain counts only when the unified key is also present (same rule as
  // the images capability stage and the resolver).
  if (freeImageChainReady(env)) {
    const freeChain = resolveFreeImageModels(env);
    const head = freeChain.slice(0, 3).join(", ") + (freeChain.length > 3 ? ", +" + (freeChain.length - 3) : "");
    return hasFal && paidImage
      ? `freellmapi media [${head}] (free-first) -> fal/${model} + ${editModel} (paid last resort)`
      : `freellmapi media [${head}] (free only, no paid fallback)`;
  }
  return hasFal
    ? `fal/${model} + ${editModel}`
    : "unavailable (no free FreeLLMAPI image chain, no fal credential)";
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
    else if (spec.id === "visual_qa") provider = visualQaProvider(env);
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
