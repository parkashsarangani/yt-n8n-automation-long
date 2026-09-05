/**
 * Credential configuration.
 *
 * Reads and writes the local `.env`. Secrets never leave this module in full:
 * everything exposed to a UI is masked, because a credential that is displayed
 * is a credential that ends up in a screenshot.
 */

import { readFile, writeFile, chmod } from "node:fs/promises";

export interface CredentialSpec {
  key: string;
  label: string;
  /** Masked on the way out, and never logged. */
  secret: boolean;
  required?: boolean;
  placeholder?: string;
  help: string;
  /** What happens when it is absent. */
  fallback: string;
}

export const CREDENTIALS: CredentialSpec[] = [
  {
    key: "FREELLMAPI_API_KEY",
    label: "FreeLLMAPI unified API key",
    secret: true,
    placeholder: "freellmapi-…",
    help: "Unified key from the shared FreeLLMAPI instance. Long uses it for pinned-Gemini text/vision routing and, when selected, narration speech. It is not used for image generation.",
    fallback: "reasoning can use paid OpenAI fail-open; FreeLLM speech requires this key",
  },
  {
    key: "LLM_ROUTER_MODE",
    label: "LLM router mode",
    secret: false,
    placeholder: "freellmapi",
    help: "Use freellmapi for pinned-Gemini reasoning/vision, or direct for immediate OpenAI rollback.",
    fallback: "freellmapi is used",
  },
  {
    key: "LLM_ROUTER_FAIL_OPEN_TO_DIRECT",
    label: "Fail open to paid OpenAI",
    secret: false,
    placeholder: "true",
    help: "When true, a FreeLLMAPI reasoning/vision outage or quota error retries through direct OpenAI.",
    fallback: "true",
  },
  {
    key: "FREELLMAPI_BASE_URL",
    label: "FreeLLMAPI internal URL",
    secret: false,
    placeholder: "http://freellmapi:3001/v1",
    help: "Docker-internal URL of the shared FreeLLMAPI service used by reasoning, vision QA, and optional speech.",
    fallback: "http://freellmapi:3001/v1",
  },
  {
    key: "FREELLMAPI_TEXT_MODEL",
    label: "FreeLLMAPI text model",
    secret: false,
    placeholder: "gemini-2.5-flash",
    help: "Concrete Google Gemini model for all production reasoning agents. RFC 0010 rejects auto/auto:* routing to prevent silent quality degradation.",
    fallback: "gemini-2.5-flash",
  },
  {
    key: "FREELLMAPI_VISION_MODEL",
    label: "FreeLLMAPI vision model",
    secret: false,
    placeholder: "auto:smart",
    help: "FreeLLMAPI model/profile for visual QA. The explicit Gemini pin currently applies to creative text generation.",
    fallback: "auto:smart",
  },
  {
    key: "LLM_ROUTER_TIMEOUT_MS",
    label: "FreeLLMAPI reasoning timeout",
    secret: false,
    placeholder: "120000",
    help: "Deadline for one free-first reasoning request before paid fail-open is considered.",
    fallback: "120000 ms",
  },
  {
    key: "SPEECH_PROVIDER_MODE",
    label: "Speech provider mode",
    secret: false,
    placeholder: "freellmapi",
    help: "freellmapi uses shared free TTS; elevenlabs restores timestamped ElevenLabs narration.",
    fallback: "raw engine defaults to elevenlabs; production Compose explicitly selects freellmapi",
  },
  {
    key: "FREELLMAPI_SPEECH_MODEL",
    label: "FreeLLMAPI speech model",
    secret: false,
    placeholder: "auto",
    help: "FreeLLMAPI audio media-registry selector. Speech may remain auto because RFC 0010's explicit model pin concerns creative text decisions.",
    fallback: "auto",
  },
  {
    key: "FREELLMAPI_SPEECH_VOICE",
    label: "FreeLLMAPI narrator voice",
    secret: false,
    placeholder: "onyx",
    help: "Requested narrator voice. FreeLLMAPI maps OpenAI-style voice names to provider-native voices when required.",
    fallback: "onyx",
  },
  {
    key: "FREELLMAPI_SPEECH_FORMAT",
    label: "FreeLLMAPI preferred speech format",
    secret: false,
    placeholder: "mp3",
    help: "Preferred format sent to FreeLLMAPI. Providers may legitimately return another real audio type; the voice artifact persists the actual response type.",
    fallback: "mp3 preference; actual provider media type is authoritative",
  },
  {
    key: "FREELLMAPI_MEDIA_TIMEOUT_MS",
    label: "FreeLLMAPI speech timeout",
    secret: false,
    placeholder: "120000",
    help: "Deadline for one FreeLLM speech request. FreeLLMAPI is no longer used for image generation.",
    fallback: "120000 ms",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API key (fallback)",
    secret: true,
    placeholder: "sk-…",
    help: "Paid fail-open and LLM_ROUTER_MODE=direct credential for reasoning/vision only.",
    fallback: "optional when FreeLLMAPI is configured; without it a reasoning/vision outage cannot fail open",
  },
  {
    key: "OPENAI_MODEL",
    label: "OpenAI fallback reasoning model",
    secret: false,
    placeholder: "gpt-5.6-luna",
    help: "Paid OpenAI model used only for reasoning/vision fail-open or direct mode.",
    fallback: "gpt-5.6-luna is used",
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API key (speech rollback)",
    secret: true,
    help: "Retained for SPEECH_PROVIDER_MODE=elevenlabs rollback.",
    fallback: "not required while SPEECH_PROVIDER_MODE=freellmapi",
  },
  {
    key: "ELEVENLABS_VOICE_ID",
    label: "ElevenLabs voice ID",
    secret: false,
    placeholder: "e.g. UgBBYS2sOqTuMpoF3BR0",
    help: "Used only when SPEECH_PROVIDER_MODE=elevenlabs.",
    fallback: "a placeholder voice id is used only on the ElevenLabs path",
  },
  {
    key: "FAL_KEY",
    label: "fal.ai image API key",
    secret: true,
    required: true,
    placeholder: "fal key",
    help: "Primary and sole generated-image credential after RFC 0010. Used for FLUX.2 generation and reference-conditioned continuity edits.",
    fallback: "generated-image visual beats are unavailable; there is no FreeLLM image fallback",
  },
  {
    key: "FAL_MODEL",
    label: "fal.ai image model",
    secret: false,
    placeholder: "fal-ai/flux-2",
    help: "Text-to-image model used for standard RFC 0010 generated-image beats.",
    fallback: "fal-ai/flux-2",
  },
  {
    key: "FAL_EDIT_MODEL",
    label: "fal.ai continuity/edit model",
    secret: false,
    placeholder: "fal-ai/flux-2/edit",
    help: "Reference-conditioned image edit model used to preserve recurring people, objects, locations, and shot continuity.",
    fallback: "${FAL_MODEL}/edit",
  },
  {
    key: "FAL_PRICE_PER_IMAGE",
    label: "fal.ai image cost override",
    secret: false,
    placeholder: "",
    help: "Optional USD-per-generated-image override used only for cost accounting.",
    fallback: "provider default accounting value",
  },
  {
    key: "PEXELS_API_KEY",
    label: "Pexels API key (legacy)",
    secret: true,
    help: "Legacy stock-video pipeline only; RFC 0010 stock verification will use it only after frame-level candidate scoring is implemented.",
    fallback: "not required for current RFC 0010 generated-image benchmark",
  },
  {
    key: "UNSPLASH_ACCESS_KEY",
    label: "Unsplash access key (legacy)",
    secret: true,
    help: "Legacy stock-image pipeline only; not used by RFC 0010 generated-image routing.",
    fallback: "not required",
  },
  {
    key: "PIXABAY_API_KEY",
    label: "Pixabay API key (legacy)",
    secret: true,
    help: "Legacy stock-image pipeline only; not used by RFC 0010 generated-image routing.",
    fallback: "not required",
  },
  {
    key: "MEASURE_EXCLUDE_IDS",
    label: "Exclude from analytics",
    secret: false,
    placeholder: "videoId1,videoId2",
    help: "Comma-separated YouTube video ids to keep out of the feedback loop — test uploads, one-offs, anything whose numbers would mislead",
    fallback: "every public published episode is measured",
  },
  {
    key: "SCHEDULE_MEASURE_HOURS",
    label: "Auto-measure every N hours",
    secret: false,
    placeholder: "24",
    help: "Measurement is read-only, so this is on by default once analytics works. Set 0 to disable",
    fallback: "measures once a day",
  },
  {
    key: "SCHEDULE_PRODUCE_HOURS",
    label: "Auto-start a production run every N hours",
    secret: false,
    placeholder: "24",
    help: "OFF unless set. Discovers a topic and starts the illustrated-story production graph.",
    fallback: "runs are started by hand only",
  },
  {
    key: "COMPOSE_URL",
    label: "long-compose URL",
    secret: false,
    placeholder: "http://localhost:4001",
    help: "your own render service — docker compose up -d --build",
    fallback: "a fake renderer produces placeholder bytes",
  },
  {
    key: "YOUTUBE_CLIENT_ID",
    label: "YouTube OAuth client ID",
    secret: false,
    placeholder: "…apps.googleusercontent.com",
    help: "Google Cloud console → Credentials → OAuth 2.0 Client ID (Desktop app)",
    fallback: "publishing falls back to the short-lived access token, then dry-run",
  },
  {
    key: "YOUTUBE_CLIENT_SECRET",
    label: "YouTube OAuth client secret",
    secret: true,
    placeholder: "GOCSPX-…",
    help: "shown next to the client ID in the Google Cloud console",
    fallback: "publishing falls back to the short-lived access token, then dry-run",
  },
  {
    key: "YOUTUBE_REFRESH_TOKEN",
    label: "YouTube refresh token",
    secret: true,
    help: "from the repo root, once: node --import tsx scripts/youtube-token.ts --auth",
    fallback: "publishing falls back to the short-lived access token, then dry-run",
  },
  {
    key: "YOUTUBE_ACCESS_TOKEN",
    label: "YouTube access token (stopgap)",
    secret: true,
    help: "expires in ~1h. Prefer the OAuth trio above, which refreshes itself",
    fallback: "publishing runs against a dry-run target",
  },
];

export interface CredentialStatus {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string | null;
  help: string;
  fallback: string;
  set: boolean;
  /** Masked hint so the operator can tell *which* key is loaded. Never the value. */
  preview: string | null;
}

export function maskValue(value: string, secret: boolean): string {
  if (!secret) return value;
  const v = value.trim();
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export function credentialStatus(env: NodeJS.ProcessEnv = process.env): CredentialStatus[] {
  return CREDENTIALS.map((spec) => {
    const raw = env[spec.key];
    const value = raw && raw.trim() ? raw.trim() : null;
    return {
      key: spec.key,
      label: spec.label,
      secret: spec.secret,
      required: spec.required ?? false,
      placeholder: spec.placeholder ?? null,
      help: spec.help,
      fallback: spec.fallback,
      set: value !== null,
      preview: value ? maskValue(value, spec.secret) : null,
    };
  });
}

/** Parse a .env into ordered lines so comments and unknown keys survive a write. */
function parseLines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

export async function readEnvFile(file: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const out: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]!] = stripQuotes(m[2]!.trim());
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function formatValue(v: string): string {
  return /[\s#"']/.test(v) ? JSON.stringify(v) : v;
}

export interface EnvWriteResult {
  applied: string[];
  rejected: string[];
}

/**
 * Update `.env` in place, preserving comments, ordering, and unrelated keys.
 * An empty string clears a key. Only keys in CREDENTIALS may be written.
 */
export async function writeEnvFile(
  file: string,
  updates: Record<string, string>,
): Promise<EnvWriteResult> {
  const allowed = new Set(CREDENTIALS.map((c) => c.key));
  const applied: string[] = [];
  const rejected = Object.keys(updates).filter((k) => !allowed.has(k));

  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const lines = parseLines(existing);
  const remaining = new Map<string, string>();
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.has(k)) continue;
    remaining.set(k, v);
  }

  const rewritten = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) return line;
    const key = m[1]!;
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    applied.push(key);
    return `${key}=${value === "" ? "" : formatValue(value)}`;
  });

  for (const [key, value] of remaining) {
    applied.push(key);
    rewritten.push(`${key}=${value === "" ? "" : formatValue(value)}`);
  }

  const text = rewritten.join("\n").replace(/\n*$/, "\n");
  await writeFile(file, text, "utf8");
  await chmod(file, 0o600).catch(() => {});

  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.has(k)) continue;
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  return { applied, rejected };
}
