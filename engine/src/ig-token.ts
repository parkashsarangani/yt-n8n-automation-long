/**
 * Instagram-login access token that renews itself (Shorts phase 2,
 * 2026-09-29). The operator chose the "API setup with Instagram login" token
 * (fewest clicks, no Page-token dance); it lasts 60 days and can be renewed
 * with GET graph.instagram.com/refresh_access_token once it is 24 h old.
 *
 * The renewed token must survive restarts but the GitHub secret cannot be
 * rewritten from here, so it is kept on the data volume. The file records a
 * hash of the secret it was derived from: when the operator pastes a NEW
 * token into GitHub, the hash no longer matches and the new token wins.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Renew once a week -- far inside the 60-day life, and past the 24 h minimum. */
export const IG_TOKEN_REFRESH_AFTER_MS = 7 * 24 * 3600_000;

interface Stored { source: string; token: string; refreshed_at: string; expires_at?: string }

export class IgTokenStore {
  private cached: Stored | null = null;

  constructor(
    private readonly envToken: string,
    private readonly file: string,
    private readonly opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  private get source(): string {
    return createHash("sha256").update(this.envToken).digest("hex").slice(0, 16);
  }

  private async load(): Promise<Stored> {
    if (this.cached) return this.cached;
    try {
      const s = JSON.parse(await readFile(this.file, "utf8")) as Stored;
      if (s.source === this.source && s.token) return (this.cached = s);
    } catch { /* first run, or unreadable: start from the secret */ }
    // A new (or first) secret from GitHub. Treat it as freshly issued, and
    // persist that at once: an unsaved "issued now" would reset on every
    // restart and the token would never reach its renewal age.
    const fresh = { source: this.source, token: this.envToken, refreshed_at: new Date(this.now()).toISOString() };
    await this.save(fresh);
    return (this.cached = fresh);
  }

  private async save(s: Stored): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${this.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** The token to use right now. */
  async get(): Promise<string> {
    return (await this.load()).token;
  }

  /** Renew if it is due. Returns what happened, for the scheduler log. */
  async refreshIfDue(): Promise<"refreshed" | "not_due"> {
    const s = await this.load();
    if (this.now() - Date.parse(s.refreshed_at) < IG_TOKEN_REFRESH_AFTER_MS) return "not_due";
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    const res = await (this.opts.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${s.token}` } });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (!res.ok || !body.access_token) {
      const detail = (body.error?.message ?? `HTTP ${res.status}`).split(s.token).join("[REDACTED]");
      throw new Error(`Instagram token renewal failed: ${detail}`);
    }
    const now = this.now();
    const next: Stored = {
      source: s.source, token: body.access_token, refreshed_at: new Date(now).toISOString(),
      ...(typeof body.expires_in === "number" ? { expires_at: new Date(now + body.expires_in * 1000).toISOString() } : {}),
    };
    await this.save(next);
    this.cached = next;
    return "refreshed";
  }
}
