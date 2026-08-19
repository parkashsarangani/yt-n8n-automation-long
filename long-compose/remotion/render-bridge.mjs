/**
 * render-bridge.mjs
 * -----------------------------------------------------------------------
 * Bridge between compose.js (CommonJS) and Remotion's ESM renderer.
 * Called as a child process for each template scene.
 *
 * Usage:
 *   node render-bridge.mjs <compositionId> <outputPath> <durationSec> <propsJson|@filepath>
 * -----------------------------------------------------------------------
 */

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [compositionId, outputPath, durationSecStr, propsJsonStr] = process.argv.slice(2);

if (!compositionId || !outputPath) {
    console.error("Usage: node render-bridge.mjs <compositionId> <outputPath> <durationSec> <propsJson|@filepath>");
    process.exit(1);
}

// Support reading props from a file to avoid E2BIG on large payloads.
const propsRaw = propsJsonStr?.startsWith("@")
    ? readFileSync(propsJsonStr.slice(1), "utf8")
    : (propsJsonStr || "{}");

const durationSec = parseFloat(durationSecStr) || 4;
const inputProps = JSON.parse(propsRaw);
const fps = 30;
const durationInFrames = Math.ceil(durationSec * fps);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Remotion's own documentation explicitly recommends bundling only when the
// source changes and reusing that bundle for multiple renders. Cartoon mode
// can render dozens of Remotion scenes per episode, so doing a full Webpack
// bundle in every child process wastes substantial CPU/RAM and makes concurrent
// scenes fight for memory. Use a shared on-disk bundle guarded by a tiny lock.
const bundleDir = process.env.REMOTION_BUNDLE_DIR || path.join(os.tmpdir(), "vidgen-remotion-bundle");
const bundleMarker = path.join(bundleDir, ".vidgen-bundle-stamp");
const bundleLock = `${bundleDir}.lock`;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 3 * 60 * 1000;

function latestMtime(target) {
    if (!existsSync(target)) return 0;
    const stat = statSync(target);
    if (!stat.isDirectory()) return stat.mtimeMs;

    let latest = stat.mtimeMs;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
        // node_modules is intentionally excluded; dependency changes update the
        // package manifests/lockfile, which are included separately below.
        if (entry.name === "node_modules" || entry.name === ".render-bundle") continue;
        latest = Math.max(latest, latestMtime(path.join(target, entry.name)));
    }
    return latest;
}

function sourceStamp() {
    return Math.max(
        latestMtime(path.join(__dirname, "src")),
        latestMtime(path.join(__dirname, "public")),
        latestMtime(path.join(__dirname, "package.json")),
        latestMtime(path.join(__dirname, "package-lock.json")),
    );
}

function cachedBundleIsFresh(stamp) {
    if (!existsSync(path.join(bundleDir, "index.html")) || !existsSync(bundleMarker)) return false;
    try {
        const builtFor = Number(readFileSync(bundleMarker, "utf8"));
        return Number.isFinite(builtFor) && builtFor >= stamp;
    } catch {
        return false;
    }
}

function removeStaleLock() {
    if (!existsSync(bundleLock)) return;
    try {
        if (Date.now() - statSync(bundleLock).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(bundleLock);
            console.warn("[remotion] removed stale bundle lock");
        }
    } catch {
        // Another renderer may have removed it between existsSync/statSync.
    }
}

async function getBundleLocation() {
    const stamp = sourceStamp();
    if (cachedBundleIsFresh(stamp)) {
        console.log(`[remotion] Reusing bundle: ${bundleDir}`);
        return bundleDir;
    }

    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        removeStaleLock();

        let lockFd;
        try {
            lockFd = openSync(bundleLock, "wx");
        } catch (err) {
            if (err?.code !== "EEXIST") throw err;

            if (cachedBundleIsFresh(stamp)) return bundleDir;
            if (Date.now() >= deadline) {
                throw new Error(`timed out waiting for Remotion bundle lock: ${bundleLock}`);
            }
            await sleep(250);
            continue;
        }

        try {
            // Recheck after acquiring the lock: a preceding process may have
            // completed the bundle between our earlier check and lock attempt.
            if (cachedBundleIsFresh(stamp)) return bundleDir;

            console.log(`[remotion] Bundling once for shared scene renders...`);
            rmSync(bundleDir, { recursive: true, force: true });
            const location = await bundle({
                entryPoint: path.resolve(__dirname, "./src/index.ts"),
                outDir: bundleDir,
                rootDir: __dirname,
                publicDir: path.join(__dirname, "public"),
                webpackOverride: (config) => config,
            });
            writeFileSync(bundleMarker, String(stamp));
            console.log(`[remotion] Bundle ready: ${location}`);
            return location;
        } finally {
            if (lockFd !== undefined) closeSync(lockFd);
            try { unlinkSync(bundleLock); } catch { /* already removed */ }
        }
    }
}

async function main() {
    const bundleLocation = await getBundleLocation();

    console.log(`[remotion] Selecting composition: ${compositionId}`);
    const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: compositionId,
        inputProps,
    });

    // Override duration to match actual audio/scene length.
    composition.durationInFrames = durationInFrames;
    composition.fps = fps;
    composition.width = 1920;
    composition.height = 1080;

    console.log(`[remotion] Rendering ${durationInFrames} frames (${durationSec}s)...`);
    await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: "h264",
        outputLocation: outputPath,
        inputProps,
        chromiumOptions: {
            gl: "angle",
        },
        // Studio-quality intermediate; the final compose pass encodes once more.
        videoBitrate: "8M",
    });

    console.log(`[remotion] Done: ${outputPath}`);
}

main().catch((err) => {
    console.error("[remotion] FATAL:", err);
    process.exit(1);
});
