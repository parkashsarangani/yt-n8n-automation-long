/**
 * Cloudflare Access verification for the remote editor UI.
 *
 * The UI is reachable off-box only through a Cloudflare Tunnel on a hostname
 * listed in UI_PUBLIC_HOSTS. Cloudflare Access puts a login in front of that
 * hostname and stamps every request it lets through with a signed JWT in the
 * Cf-Access-Jwt-Assertion header. The tunnel alone is not trusted: anything
 * else able to reach port 4321 could forge a Host header, so a public-host
 * request is served only when that JWT verifies against the team's published
 * keys, names our application's audience, and has not expired.
 */

import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export interface AccessIdentity {
  email: string;
}

export interface AccessConfig {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const KEY_TTL_MS = 60 * 60_000;

export class CloudflareAccessVerifier {
  private readonly issuer: string;
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: AccessConfig) {
    const domain = cfg.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.issuer = `https://${domain}`;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  /** The identity in a valid token, or null for anything missing, forged, expired or meant for another app. */
  async verify(token: string | string[] | undefined): Promise<AccessIdentity | null> {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (header.alg !== "RS256" || !header.kid) return null;

    const key = await this.key(header.kid);
    if (!key) return null;
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return null;

    const nowSec = this.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.audience)) return null;
    if (claims.iss !== this.issuer) return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSec) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSec + 60) return null;
    return { email: typeof claims.email === "string" ? claims.email : "unknown" };
  }

  /** Keys rotate, so an unknown kid forces one refetch before the token is refused. */
  private async key(kid: string): Promise<KeyObject | undefined> {
    const stale = this.now() - this.fetchedAt > KEY_TTL_MS;
    if (stale || !this.keys.has(kid)) await this.refresh().catch(() => undefined);
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Cloudflare Access certs fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid) next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    this.keys = next;
    this.fetchedAt = this.now();
  }
}

/** Hostnames the tunnel serves, from UI_PUBLIC_HOSTS (comma-separated). */
export function publicUiHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env["UI_PUBLIC_HOSTS"] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** A verifier when Access is fully configured, else null -- public hosts are then refused outright. */
export function accessVerifierFromEnv(env: NodeJS.ProcessEnv = process.env): CloudflareAccessVerifier | null {
  const teamDomain = env["CF_ACCESS_TEAM_DOMAIN"]?.trim();
  const audience = env["CF_ACCESS_AUD"]?.trim();
  return teamDomain && audience ? new CloudflareAccessVerifier({ teamDomain, audience }) : null;
}
