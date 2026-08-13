#!/usr/bin/env node
/**
 * YouTube OAuth2 token helper.
 *
 * Two modes:
 *
 *   1. First-time setup (get a refresh token):
 *      node --import tsx scripts/youtube-token.ts --auth
 *
 *      Opens a URL you paste into a browser, you authorize, paste the code back,
 *      and it prints your refresh token. Save it in .env as YOUTUBE_REFRESH_TOKEN.
 *
 *   2. Refresh (get a fresh access token):
 *      node --import tsx scripts/youtube-token.ts
 *
 *      Reads YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
 *      from the .env beside this script's parent (the repo root .env), exchanges
 *      the refresh token for a fresh access token, and writes it back to
 *      YOUTUBE_ACCESS_TOKEN in that same .env.
 *
 * Requirements:
 *   - YouTube Data API v3 enabled in your Google Cloud project
 *   - OAuth 2.0 Client ID (type: Desktop app)
 *   - Scope: https://www.googleapis.com/auth/youtube.upload
 *
 * No dependencies beyond Node.js built-ins.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");
const BRAIN_ENV_PATH = resolve(__dirname, "..", "brain", ".env");

const SCOPES = "https://www.googleapis.com/auth/youtube.upload";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEnv(path: string): Record<string, string> {
    let content: string;
    try {
        content = readFileSync(path, "utf-8");
    } catch {
        return {};
    }
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        env[key] = val;
    }
    return env;
}

function writeEnvKey(path: string, key: string, value: string): void {
    let content: string;
    try {
        content = readFileSync(path, "utf-8");
    } catch {
        content = "";
    }

    const lines = content.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        if (trimmed.slice(0, eq).trim() === key) {
            lines[i] = `${key}=${value}`;
            found = true;
            break;
        }
    }
    if (!found) {
        lines.push(`${key}=${value}`);
    }
    writeFileSync(path, lines.join("\n"));
}

function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function requireEnv(env: Record<string, string>, key: string): string {
    const val = env[key];
    if (!val) {
        console.error(`ERROR: ${key} is not set in ${ENV_PATH}`);
        console.error(`Add it to your .env file and try again.`);
        process.exit(1);
    }
    return val;
}

// ---------------------------------------------------------------------------
// Auth flow (first-time setup)
// ---------------------------------------------------------------------------

async function authFlow(): Promise<void> {
    const env = readEnv(ENV_PATH);
    const clientId = requireEnv(env, "YOUTUBE_CLIENT_ID");
    const clientSecret = requireEnv(env, "YOUTUBE_CLIENT_SECRET");

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    console.log("\n1. Open this URL in your browser:\n");
    console.log(`   ${authUrl.toString()}\n`);
    console.log("2. Authorize the app and copy the authorization code.\n");

    const code = await ask("3. Paste the code here: ");

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
            grant_type: "authorization_code",
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        console.error(`\nERROR: token exchange failed (${res.status}):\n${text}`);
        process.exit(1);
    }

    const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
    };

    if (!data.refresh_token) {
        console.error("\nERROR: no refresh_token in response. Try adding prompt=consent or revoking app access and retrying.");
        process.exit(1);
    }

    console.log("\n=== Success ===\n");
    console.log(`Refresh token: ${data.refresh_token}`);
    console.log(`Access token:  ${data.access_token} (expires in ${data.expires_in}s)\n`);

    // Write to root .env
    writeEnvKey(ENV_PATH, "YOUTUBE_REFRESH_TOKEN", data.refresh_token);
    writeEnvKey(ENV_PATH, "YOUTUBE_ACCESS_TOKEN", data.access_token);
    console.log(`Written to ${ENV_PATH}`);

    // Also write to brain .env if it exists
    try {
        readFileSync(BRAIN_ENV_PATH, "utf-8");
        writeEnvKey(BRAIN_ENV_PATH, "YOUTUBE_ACCESS_TOKEN", data.access_token);
        console.log(`Written to ${BRAIN_ENV_PATH}`);
    } catch {
        // brain/.env doesn't exist, skip
    }

    console.log("\nAdd YOUTUBE_REFRESH_TOKEN to your .env if it wasn't already there.");
    console.log("From now on, just run: node --import tsx scripts/youtube-token.ts");
}

// ---------------------------------------------------------------------------
// Refresh flow (normal usage)
// ---------------------------------------------------------------------------

async function refreshFlow(): Promise<void> {
    const env = readEnv(ENV_PATH);
    const clientId = requireEnv(env, "YOUTUBE_CLIENT_ID");
    const clientSecret = requireEnv(env, "YOUTUBE_CLIENT_SECRET");
    const refreshToken = requireEnv(env, "YOUTUBE_REFRESH_TOKEN");

    console.log("Refreshing YouTube access token...");

    const res = await fetch(TOKEN_URL, {
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
        const text = await res.text();
        console.error(`ERROR: refresh failed (${res.status}):\n${text}`);
        if (res.status === 400 || res.status === 401) {
            console.error("\nThe refresh token may be revoked. Run with --auth to re-authorize.");
        }
        process.exit(1);
    }

    const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
    };

    // Write to root .env
    writeEnvKey(ENV_PATH, "YOUTUBE_ACCESS_TOKEN", data.access_token);
    console.log(`Access token updated in ${ENV_PATH}`);

    // Also write to brain .env if it exists
    try {
        readFileSync(BRAIN_ENV_PATH, "utf-8");
        writeEnvKey(BRAIN_ENV_PATH, "YOUTUBE_ACCESS_TOKEN", data.access_token);
        console.log(`Access token updated in ${BRAIN_ENV_PATH}`);
    } catch {
        // brain/.env doesn't exist, skip
    }

    console.log(`\nDone. Token valid for ${Math.floor(data.expires_in / 60)} minutes.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const isAuth = process.argv.includes("--auth");
    if (isAuth) {
        await authFlow();
    } else {
        await refreshFlow();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
