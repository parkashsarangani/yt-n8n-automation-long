/**
 * render-bridge.mjs
 * -----------------------------------------------------------------------
 * Bridge between compose.js (CommonJS) and Remotion's ESM renderer.
 * Called via child_process.fork() from compose.js with JSON args on stdin.
 *
 * Usage:
 *   node render-bridge.mjs <compositionId> <outputPath> <durationSec> <propsJson>
 * -----------------------------------------------------------------------
 */

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [compositionId, outputPath, durationSecStr, propsJsonStr] = process.argv.slice(2);

if (!compositionId || !outputPath) {
    console.error("Usage: node render-bridge.mjs <compositionId> <outputPath> <durationSec> <propsJson>");
    process.exit(1);
}

const durationSec = parseFloat(durationSecStr) || 4;
const inputProps = JSON.parse(propsJsonStr || "{}");
const fps = 30;
const durationInFrames = Math.ceil(durationSec * fps);

async function main() {
    console.log(`[remotion] Bundling...`);
    const bundleLocation = await bundle({
        entryPoint: path.resolve(__dirname, "./src/index.ts"),
        webpackOverride: (config) => config,
    });

    console.log(`[remotion] Selecting composition: ${compositionId}`);
    const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: compositionId,
        inputProps,
    });

    // Override duration to match actual audio/scene length
    composition.durationInFrames = durationInFrames;
    composition.fps = fps;
    composition.width = 1080;
    composition.height = 1920;

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
        // Studio-quality encoding for intermediate (will be re-encoded in final pass)
        videoBitrate: "8M",
    });

    console.log(`[remotion] Done: ${outputPath}`);
}

main().catch((err) => {
    console.error("[remotion] FATAL:", err);
    process.exit(1);
});
