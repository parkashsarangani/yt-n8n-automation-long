/**
 * Google Drive OAuth2 token refresh.
 *
 * Mirrors youtube-auth.ts's shape exactly (same Google refresh-token flow,
 * different scope). Kept as a sibling file rather than generalizing
 * youtube-auth.ts -- low-risk, doesn't touch the already-working YouTube auth.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Safety margin: refresh 5 minutes before actual expiry. */
const MARGIN_MS = 5 * 60 * 1000;

export interface DriveAuthOptions {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** Override for testing. */
    fetchImpl?: typeof fetch;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number; // Date.now()-style ms
}

export interface TokenFactory {
    (): Promise<string>;
}

/**
 * Returns a function that resolves to a fresh Drive access token. Caches the
 * token in memory and refreshes only when it's about to expire.
 */
export function driveTokenFactory(opts: DriveAuthOptions): TokenFactory {
    const { clientId, clientSecret, refreshToken } = opts;
    const fetchImpl = opts.fetchImpl ?? fetch;

    let cached: CachedToken | null = null;
    let inflight: Promise<string> | null = null;

    async function refresh(): Promise<string> {
        const res = await fetchImpl(TOKEN_URL, {
            signal: AbortSignal.timeout(30_000),
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }),
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(
                `Drive token refresh failed (${res.status}): ${body.slice(0, 300)}`,
            );
        }

        const data = (await res.json()) as { access_token: string; expires_in: number };
        cached = {
            accessToken: data.access_token,
            expiresAt: Date.now() + data.expires_in * 1000 - MARGIN_MS,
        };
        return cached.accessToken;
    }

    return async () => {
        if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
        if (!inflight) inflight = refresh().finally(() => { inflight = null; });
        return inflight;
    };
}

/**
 * Full Drive scope, not the narrower drive.file: the editor uploads the
 * finished cut directly through the Drive UI, and drive.file only grants
 * visibility into files the app itself created.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
