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
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { reviewRfc0010Scene, reviewSemanticMotion } from "./semantic-motion-qa.mjs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
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
//
// Each distinct source stamp gets its own versioned directory rather than one
// shared path that gets rm'd and rebuilt in place. compose.js renders several
// scenes concurrently, each in its own render-bridge process reading from
// whatever bundle directory it resolved - an in-place rm+rebuild could delete
// files out from under a sibling process that is still mid-renderMedia() on
// the old bundle. Old versioned directories are pruned, but only once they
// are old enough that nothing could still be reading from them.
const bundleBaseDir = process.env.REMOTION_BUNDLE_DIR || path.join(os.tmpdir(), "vidgen-remotion-bundle");
const bundleLock = `${bundleBaseDir}.lock`;
const LOCK_STALE_MS = 5 * 60 * 1000;
// Must exceed LOCK_STALE_MS: a waiter should only give up once the lock it is
// waiting on would itself be reclaimed as stale, never before - otherwise a
// legitimately slow (but alive) cold bundle fails every sibling scene queued
// behind it, which is exactly what a 3-minute wait against a 5-minute stale
// threshold used to do.
const LOCK_WAIT_MS = LOCK_STALE_MS + 60 * 1000;
// compose.js kills any single scene's render-bridge child after 5 minutes
// (execFileAsync's `timeout`), so no renderMedia() call can still be reading
// a bundle directory more than ~2x that after the directory was built. Prune
// only once safely past that window.
const BUNDLE_RETENTION_MS = 15 * 60 * 1000;

function bundleDirFor(stamp) {
    return path.join(bundleBaseDir, `v-${stamp}`);
}

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
    return existsSync(path.join(bundleDirFor(stamp), "index.html"));
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

// Deletes old versioned bundle directories, skipping the one just built and
// anything not yet old enough for BUNDLE_RETENTION_MS to guarantee no
// concurrent renderer could still be reading it.
function pruneOldBundles(currentStamp) {
    if (!existsSync(bundleBaseDir)) return;
    for (const entry of readdirSync(bundleBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("v-") || entry.name === `v-${currentStamp}`) continue;
        const full = path.join(bundleBaseDir, entry.name);
        try {
            if (Date.now() - statSync(full).mtimeMs > BUNDLE_RETENTION_MS) {
                rmSync(full, { recursive: true, force: true });
            }
        } catch {
            // Another process may already be pruning/using it; skip.
        }
    }
}

async function getBundleLocation() {
    const stamp = sourceStamp();
    if (cachedBundleIsFresh(stamp)) {
        const dir = bundleDirFor(stamp);
        console.log(`[remotion] Reusing bundle: ${dir}`);
        return dir;
    }

    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        removeStaleLock();

        let lockFd;
        try {
            lockFd = openSync(bundleLock, "wx");
        } catch (err) {
            if (err?.code !== "EEXIST") throw err;

            if (cachedBundleIsFresh(stamp)) return bundleDirFor(stamp);
            if (Date.now() >= deadline) {
                throw new Error(`timed out waiting for Remotion bundle lock: ${bundleLock}`);
            }
            await sleep(250);
            continue;
        }

        try {
            // Recheck after acquiring the lock: a preceding process may have
            // completed the bundle between our earlier check and lock attempt.
            if (cachedBundleIsFresh(stamp)) return bundleDirFor(stamp);

            const dir = bundleDirFor(stamp);
            // Build into a process-private temp directory and only rename it
            // into place once webpack has fully finished. Directory rename is
            // atomic on POSIX, so a sibling process's existsSync(index.html)
            // check can never observe a partially-written bundle: either the
            // final directory doesn't exist yet, or it's complete. Building
            // straight into `dir` let a reader see index.html the moment
            // webpack emitted it, while later chunk files were still being
            // flushed, occasionally handing a concurrent renderMedia() call a
            // truncated bundle.js that only had part of the Root registered
            // (surfaced as "Could not find composition ... Available
            // compositions: <one arbitrary composition>").
            const buildingDir = `${dir}.building-${process.pid}`;
            rmSync(buildingDir, { recursive: true, force: true });
            console.log(`[remotion] Bundling once for shared scene renders...`);
            await bundle({
                entryPoint: path.resolve(__dirname, "./src/index.ts"),
                outDir: buildingDir,
                rootDir: __dirname,
                publicDir: path.join(__dirname, "public"),
                webpackOverride: (config) => config,
            });
            renameSync(buildingDir, dir);
            pruneOldBundles(stamp);
            console.log(`[remotion] Bundle ready: ${dir}`);
            return dir;
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

    // RFC 0010 pixel gate. Unlike the advisory legacy check below, this one is
    // authoritative -- but it can afford to be, because failing it costs a
    // downgrade to this beat's own kinetic-text form rather than an aborted
    // render or a placeholder. The first complete RFC 0010 candidate shipped
    // five graphics that showed none of what their beat asked for; nothing
    // between the planner and the final encode was in a position to notice.
    let renderProps = inputProps;
    if (inputProps?.rfc0010SemanticScene && inputProps?.rfc0010FallbackScene) {
        try {
            const gate = await reviewRfc0010Scene({composition, serveUrl: bundleLocation, inputProps, renderStill});
            if (gate && !gate.ok) {
                console.warn(
                    `[remotion] rfc0010 scene "${inputProps.rfc0010SemanticScene.kind}" failed its pixel gate ` +
                    `(${gate.failures.join("; ")}); rendering this beat as kinetic text instead. ` +
                    `metrics=${JSON.stringify(gate.deterministic)}`,
                );
                renderProps = {...inputProps, rfc0010SemanticScene: inputProps.rfc0010FallbackScene, rfc0010GateFailed: true};
            } else if (gate) {
                console.log(`[remotion] rfc0010 scene "${inputProps.rfc0010SemanticScene.kind}" cleared its pixel gate`);
            }
        } catch (error) {
            // An unreachable critic or a still-render hiccup is a QA
            // availability problem. It must not rewrite the episode.
            console.warn(`[remotion] rfc0010 pixel gate could not run (keeping the authored scene): ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Motion QA for semantic scenes: inspect the actual rendered pixels at
    // 20%, 55%, and 85% before spending time on the full scene encode.
    // Non-blocking by design (operator decision) -- a failure here means a
    // scene is likely frozen/static or otherwise visually weak, which is
    // worth knowing about, but production runs must not stop on it. Log the
    // full failure (metrics included) so a frozen scene is still visible in
    // the render logs, then keep going.
    try {
        await reviewSemanticMotion({composition,serveUrl:bundleLocation,inputProps:renderProps,renderStill});
    } catch (error) {
        console.warn(`[remotion] motion visual QA would have failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log(`[remotion] Rendering ${durationInFrames} frames (${durationSec}s)...`);
    await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: "h264",
        outputLocation: outputPath,
        inputProps: renderProps,
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
