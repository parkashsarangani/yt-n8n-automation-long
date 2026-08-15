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
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    secret: true,
    required: true,
    placeholder: "sk-ant-…",
    help: "console.anthropic.com → API keys",
    fallback: "required — the reasoning agents cannot run without it",
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API key",
    secret: true,
    help: "elevenlabs.io → profile menu → API key",
    fallback: "fake audio is generated instead",
  },
  {
    key: "ELEVENLABS_VOICE_ID",
    label: "ElevenLabs voice ID",
    secret: false,
    placeholder: "e.g. UgBBYS2sOqTuMpoF3BR0",
    help: "Voices → pick a voice → copy its ID (not its name)",
    fallback: "a placeholder voice id is used",
  },
  {
    key: "PEXELS_API_KEY",
    label: "Pexels API key",
    secret: true,
    help: "pexels.com/api → your key. Free, no card. First choice for scene images",
    fallback: "Unsplash is tried instead; without either, placeholder images",
  },
  {
    key: "UNSPLASH_ACCESS_KEY",
    label: "Unsplash access key",
    secret: true,
    help: "unsplash.com/oauth/applications → Access Key (not the Secret Key)",
    fallback: "used only when Pexels has no match, or as the sole source",
  },
  {
    key: "PIXABAY_API_KEY",
    label: "Pixabay API key",
    secret: true,
    help: "pixabay.com/api/docs — optional third fallback",
    fallback: "the image search stops after Pexels and Unsplash",
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
    key: "COMPOSE_URL",
    label: "long-compose URL",
    secret: false,
    placeholder: "http://localhost:4001",
    help: "your own render service — docker compose up -d --build",
    fallback: "a fake renderer produces placeholder bytes",
  },
  // --- YouTube -------------------------------------------------------------
  // The OAuth trio is the durable path: refresh tokens do not expire, so the
  // engine mints access tokens itself. The bare access token below is the
  // one-hour stopgap kept for a quick manual test.
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

/** Values needing quoting are rare here, but a stray space would corrupt the file. */
function formatValue(v: string): string {
  return /[\s#"']/.test(v) ? JSON.stringify(v) : v;
}

export interface EnvWriteResult {
  applied: string[];
  /**
   * Keys refused because they are not in CREDENTIALS. Reported rather than
   * dropped in silence: a caller that submits a key the engine has never heard
   * of has made a mistake, and swallowing it turns a typo — or a credential
   * list that has fallen behind the code — into a config that looks saved and
   * is not.
   */
  rejected: string[];
}

/**
 * Update `.env` in place, preserving comments, ordering, and unrelated keys.
 * An empty string clears a key. Only keys in CREDENTIALS may be written, so a
 * malicious or mistyped field cannot inject arbitrary environment variables.
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
  // Best effort on POSIX; a no-op on Windows.
  await chmod(file, 0o600).catch(() => {});

  // Reflect into the live process so providers rebuilt after this see the change.
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.has(k)) continue;
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  return { applied, rejected };
}
