#!/usr/bin/env node
/**
 * Google Drive OAuth2 token helper. Mirrors scripts/youtube-token.ts exactly
 * (same Google refresh-token flow), scoped to Drive for the editor handoff.
 *
 *   1. First-time setup (get a refresh token):
 *      node --import tsx scripts/drive-token.ts --auth
 *
 *      Opens a URL you paste into a browser, you authorize, and it prints
 *      your refresh token. Save it as DRIVE_REFRESH_TOKEN.
 *
 *   2. Refresh (get a fresh access token, for manually poking the API):
 *      node --import tsx scripts/drive-token.ts
 *
 * Requirements:
 *   - Google Drive API enabled in your Google Cloud project
 *   - OAuth 2.0 Client ID (type: Desktop app)
 *   - Full https://www.googleapis.com/auth/drive scope -- NOT drive.file. The
 *     editor uploads final.mp4 directly through the Drive UI, and drive.file
 *     only grants visibility into files the app itself created.
 *
 * No dependencies beyond Node.js built-ins.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");
const ENGINE_ENV_PATH = resolve(__dirname, "..", "engine", ".env");

const SCOPES = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

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
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
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
    if (!found) lines.push(`${key}=${value}`);
    writeFileSync(path, lines.join("\n"));
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

async function authFlow(): Promise<void> {
    const env = readEnv(ENV_PATH);
    const clientId = requireEnv(env, "DRIVE_CLIENT_ID");
    const clientSecret = requireEnv(env, "DRIVE_CLIENT_SECRET");

    const REDIRECT_PORT = 8977;
    const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

    const code = await new Promise<string>((resolveCode, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", REDIRECT_URI);
            const authCode = url.searchParams.get("code");
            const error = url.searchParams.get("error");

            if (error) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
                server.close();
                reject(new Error(`Google returned error: ${error}`));
                return;
            }
            if (authCode) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(`<h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>`);
                server.close();
                resolveCode(authCode);
                return;
            }
            res.writeHead(400);
            res.end("Missing code parameter");
        });

        server.listen(REDIRECT_PORT, () => {
            const authUrl = new URL(AUTH_URL);
            authUrl.searchParams.set("client_id", clientId);
            authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("scope", SCOPES);
            authUrl.searchParams.set("access_type", "offline");
            authUrl.searchParams.set("prompt", "consent");

            console.log("\n1. Open this URL in your browser:\n");
            console.log(`   ${authUrl.toString()}\n`);
            console.log("2. Authorize the app — you'll be redirected back automatically.\n");
            console.log(`   Waiting for redirect on http://localhost:${REDIRECT_PORT} ...\n`);
        });

        setTimeout(() => { server.close(); reject(new Error("Timed out waiting for authorization")); }, 300_000);
    });

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
        }),
    });

    if (!res.ok) {
        console.error(`\nERROR: token exchange failed (${res.status}):\n${await res.text()}`);
        process.exit(1);
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) {
        console.error("\nERROR: no refresh_token in response. Try revoking app access at https://myaccount.google.com/permissions and retrying.");
        process.exit(1);
    }

    console.log("\n=== Success ===\n");
    console.log(`Refresh token: ${data.refresh_token}`);
    console.log(`Access token:  ${data.access_token} (expires in ${data.expires_in}s)\n`);

    writeEnvKey(ENV_PATH, "DRIVE_REFRESH_TOKEN", data.refresh_token);
    writeEnvKey(ENV_PATH, "DRIVE_ACCESS_TOKEN", data.access_token);
    console.log(`Written to ${ENV_PATH}`);

    try {
        readFileSync(ENGINE_ENV_PATH, "utf-8");
        writeEnvKey(ENGINE_ENV_PATH, "DRIVE_REFRESH_TOKEN", data.refresh_token);
        console.log(`Written to ${ENGINE_ENV_PATH}`);
    } catch {
        // engine/.env doesn't exist, skip
    }

    console.log("\nDone. Add DRIVE_REFRESH_TOKEN to your GitHub Secrets — it doesn't expire.");
    console.log("Also set DRIVE_ROOT_FOLDER_ID to a folder you've shared with the editor's Google account (Editor access).");
}

async function refreshFlow(): Promise<void> {
    const env = readEnv(ENV_PATH);
    const clientId = requireEnv(env, "DRIVE_CLIENT_ID");
    const clientSecret = requireEnv(env, "DRIVE_CLIENT_SECRET");
    const refreshToken = requireEnv(env, "DRIVE_REFRESH_TOKEN");

    console.log("Refreshing Drive access token...");
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
        if (res.status === 400 || res.status === 401) console.error("\nThe refresh token may be revoked. Run with --auth to re-authorize.");
        process.exit(1);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    console.log(`\nAccess token: ${data.access_token}`);
    console.log(`Valid for ${Math.floor(data.expires_in / 60)} minutes.`);
}

async function main(): Promise<void> {
    if (process.argv.includes("--auth")) await authFlow();
    else await refreshFlow();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
