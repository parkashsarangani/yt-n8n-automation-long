/**
 * YouTube OAuth2 token refresh.
 *
 * Given a client id, client secret, and refresh token, this module returns a
 * function that always resolves to a valid access token — refreshing
 * transparently when the current one expires.
 *
 * The YouTubeTarget already accepts `accessToken: () => Promise<string>`, so
 * this plugs in with zero changes to the publish path.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Safety margin: refresh 5 minutes before actual expiry. */
const MARGIN_MS = 5 * 60 * 1000;

export interface YouTubeAuthOptions {
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

/**
 * Returns a function that resolves to a fresh YouTube access token.
 * Caches the token in memory and refreshes only when it's about to expire.
 */
export function youtubeTokenFactory(opts: YouTubeAuthOptions): () => Promise<string> {
    const { clientId, clientSecret, refreshToken } = opts;
    const fetchImpl = opts.fetchImpl ?? fetch;

    let cached: CachedToken | null = null;
    let inflight: Promise<string> | null = null;

    async function refresh(): Promise<string> {
        const res = await fetchImpl(TOKEN_URL, {
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
                `YouTube token refresh failed (${res.status}): ${body.slice(0, 300)}`,
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
        if (cached && Date.now() < cached.expiresAt) {
            return cached.accessToken;
        }
        // Deduplicate concurrent refresh calls.
        if (!inflight) {
            inflight = refresh().finally(() => { inflight = null; });
        }
        return inflight;
    };
}
