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
export interface TokenFactory {
    (): Promise<string>;
    grantedScopes(): string[] | null;
    probeScopes(): Promise<string[]>;
}

export function youtubeTokenFactory(opts: YouTubeAuthOptions): TokenFactory {
    const { clientId, clientSecret, refreshToken } = opts;
    const fetchImpl = opts.fetchImpl ?? fetch;

    let cached: CachedToken | null = null;
    let inflight: Promise<string> | null = null;
    let granted: string[] | null = null;

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

        const data = (await res.json()) as {
            access_token: string;
            expires_in: number;
            scope?: string;
        };
        // Google echoes the scopes the refresh token was actually granted.
        // Recorded so a token minted before yt-analytics.readonly existed can be
        // reported as "re-authorize" rather than surfacing as an opaque 403.
        if (typeof data.scope === "string") granted = data.scope.split(/\s+/).filter(Boolean);
        cached = {
            accessToken: data.access_token,
            expiresAt: Date.now() + data.expires_in * 1000 - MARGIN_MS,
        };
        return cached.accessToken;
    }

    const token = async () => {
        if (cached && Date.now() < cached.expiresAt) {
            return cached.accessToken;
        }
        // Deduplicate concurrent refresh calls.
        if (!inflight) {
            inflight = refresh().finally(() => { inflight = null; });
        }
        return inflight;
    };

    return Object.assign(token, {
        /** Scopes on the refresh token; null until the first refresh has happened. */
        grantedScopes: (): string[] | null => granted,
        /** Force one refresh so the scopes are known, then report them. */
        probeScopes: async (): Promise<string[]> => {
            await token();
            return granted ?? [];
        },
    });
}

export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
