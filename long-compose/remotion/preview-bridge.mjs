/**
 * Fast visual-only benchmark bridge.
 *
 * Bundles Remotion once, then renders a small set of persisted CartoonScene
 * props at representative timeline frames. This deliberately skips narration,
 * Rhubarb, H.264 encoding, scene concatenation and final audio mixing: it is the
 * inner-loop tool for composition, staging, prop physicality, character art,
 * lighting and environment depth. Full MP4 renders remain the motion/audio gate.
 *
 * Usage:
 *   node preview-bridge.mjs <manifest.json> <output-dir>
 */
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { readFileSync, rmSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [manifestPath, outputDir] = process.argv.slice(2);

if (!manifestPath || !outputDir) {
    console.error("Usage: node preview-bridge.mjs <manifest.json> <output-dir>");
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("preview manifest must be a non-empty array");
}

function slug(value) {
    return String(value ?? "scene").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
}

mkdirSync(outputDir, { recursive: true });
const bundleDir = path.join(os.tmpdir(), `vidgen-remotion-preview-${process.pid}`);
rmSync(bundleDir, { recursive: true, force: true });

async function main() {
    console.log(`[preview] bundling Remotion once for ${manifest.length} matrix rows`);
    const serveUrl = await bundle({
        entryPoint: path.resolve(__dirname, "./src/index.ts"),
        outDir: bundleDir,
        rootDir: __dirname,
        publicDir: path.join(__dirname, "public"),
        webpackOverride: (config) => config,
    });

    for (const row of manifest) {
        const sceneIndex = Number(row.scene_index);
        const order = String(Number(row.preview_order) || 0).padStart(2, "0");
        const previewId = slug(row.preview_id || row.recipe || `scene-${sceneIndex}`);
        const inputProps = row.props ?? {};
        const requestedFrames = Array.isArray(row.frames) && row.frames.length ? row.frames : [18, 90];
        const composition = await selectComposition({
            serveUrl,
            id: "CartoonScene",
            inputProps,
        });
        composition.durationInFrames = 120;
        composition.fps = 30;
        composition.width = 1920;
        composition.height = 1080;

        for (const requested of requestedFrames) {
            const frame = Math.max(0, Math.min(composition.durationInFrames - 1, Number(requested) || 0));
            const output = path.join(outputDir, `${order}-${previewId}-scene-${sceneIndex}-frame-${frame}.png`);
            console.log(`[preview] ${previewId} (${row.synthetic ? "synthetic" : "persisted"}) scene ${sceneIndex}, frame ${frame} -> ${output}`);
            await renderStill({
                composition,
                serveUrl,
                output,
                inputProps,
                frame,
                imageFormat: "png",
                chromiumOptions: { gl: "angle" },
            });
        }
    }
}

main()
    .finally(() => rmSync(bundleDir, { recursive: true, force: true }))
    .catch((err) => {
        console.error("[preview] FATAL:", err);
        process.exit(1);
    });
