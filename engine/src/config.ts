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
    help: "Unified key from the shared FreeLLMAPI instance. Long uses it for text/reasoning and, when explicitly selected, optional FreeLLM speech.",
    fallback: "reasoning is unavailable without this key; there is no paid OpenAI text fallback",
  },
  {
    key: "LLM_ROUTER_MODE",
    label: "LLM router mode",
    secret: false,
    placeholder: "freellmapi",
    help: "freellmapi walks an ordered chain of concrete free models for all text. direct is a manual paid-OpenAI rollback and is never selected automatically.",
    fallback: "freellmapi (free-model chain) is used for reasoning",
  },
  {
    key: "FREELLMAPI_BASE_URL",
    label: "FreeLLMAPI internal URL",
    secret: false,
    placeholder: "http://freellmapi:3001/v1",
    help: "Docker-internal URL of the shared FreeLLMAPI service used by reasoning and optional FreeLLM speech.",
    fallback: "http://freellmapi:3001/v1",
  },
  {
    key: "FREELLMAPI_TEXT_MODELS",
    label: "FreeLLMAPI text model chain",
    secret: false,
    placeholder: "gpt-oss-120b,llama-3.3-70b-fp8-fast,nemotron-3-super-120b,gpt-oss-20b",
    help: "Comma-separated ordered list of concrete free model ids. A model that is rate-limited or unavailable hands off to the next id. auto / auto:* are rejected. A single legacy FREELLMAPI_TEXT_MODEL is still accepted as a one-item chain.",
    fallback: "built-in default chain: gpt-oss-120b, llama-3.3-70b-fp8-fast, nemotron-3-super-120b, gpt-oss-20b",
  },
  {
    key: "LLM_ROUTER_TIMEOUT_MS",
    label: "FreeLLMAPI reasoning timeout",
    secret: false,
    placeholder: "120000",
    help: "Per-model deadline for one free reasoning request before the chain advances to the next id.",
    fallback: "120000 ms",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API key",
    secret: true,
    placeholder: "sk-…",
    help: "Required for pre-TTS moderation and for the manual paid LLM_ROUTER_MODE=direct rollback.",
    fallback: "pre-TTS moderation is unavailable without it",
  },
  {
    key: "OPENAI_MODEL",
    label: "OpenAI model (manual rollback only)",
    secret: false,
    placeholder: "gpt-5.6-luna",
    help: "Paid OpenAI model used for the manual LLM_ROUTER_MODE=direct rollback.",
    fallback: "gpt-5.6-luna is used",
  },
  {
    key: "PAID_TEXT_FALLBACK",
    label: "Paid text fallback",
    secret: false,
    placeholder: "true",
    help: "When true (production default), a text request that exhausts the whole free-model chain with retryable/availability errors falls back to the paid OpenAI text model. Invalid-request / refusal / bad-credential errors still fail immediately. Set false to make free-chain exhaustion a loud hard failure with no paid call.",
    fallback: "true (paid OpenAI text fallback after the free chain is exhausted)",
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API key",
    secret: true,
    help: "Production narration credential.",
    fallback: "speech is unavailable when production uses ElevenLabs",
  },
  {
    key: "ELEVENLABS_VOICE_ID",
    label: "ElevenLabs voice ID",
    secret: false,
    placeholder: "e.g. UgBBYS2sOqTuMpoF3BR0",
    help: "Production narrator voice id.",
    fallback: "a placeholder voice id is used only in non-live fixtures",
  },
  {
    key: "FAL_KEY",
    label: "fal.ai image API key",
    secret: true,
    placeholder: "fal key",
    help: "Optional image generation for custom thumbnail artwork.",
    fallback: "thumbnail rendering uses a generated gradient",
  },
  {
    key: "FAL_MODEL",
    label: "fal.ai image model",
    secret: false,
    placeholder: "fal-ai/flux-2",
    help: "Text-to-image model used for thumbnail artwork.",
    fallback: "fal-ai/flux-2",
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
