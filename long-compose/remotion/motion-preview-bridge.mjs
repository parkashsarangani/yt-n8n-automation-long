/**
 * Fast motion-only QA bridge.
 *
 * Bundles Remotion once, then renders short low-resolution H.264 clips for a
 * handful of cinematic recipes. The source composition remains 1920x1080 so
 * all scene-space coordinates stay production-accurate; renderMedia.scale
 * reduces the encoded preview to 960x540 for a much cheaper motion loop.
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { readFileSync, rmSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [manifestPath, outputDir, recipesArg] = process.argv.slice(2);
if (!manifestPath || !outputDir) {
  console.error("Usage: node motion-preview-bridge.mjs <manifest.json> <output-dir> [recipe,recipe,...]");
  process.exit(1);
}

const wanted = new Set(
  String(recipesArg || "reaction-closeup,prop-insert,crossing-transition,payoff-hold")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const rows = manifest.filter((row) => wanted.has(String(row.recipe || "").toLowerCase()));
if (!rows.length) throw new Error("motion preview selected no rows");

mkdirSync(outputDir, { recursive: true });
const bundleDir = path.join(os.tmpdir(), `vidgen-remotion-motion-preview-${process.pid}`);
rmSync(bundleDir, { recursive: true, force: true });

async function main() {
  console.log(`[motion-preview] bundling once for ${rows.length} clips`);
  const serveUrl = await bundle({
    entryPoint: path.resolve(__dirname, "./src/index.ts"),
    outDir: bundleDir,
    rootDir: __dirname,
    publicDir: path.join(__dirname, "public"),
    webpackOverride: (config) => config,
  });

  for (const row of rows) {
    const recipe = String(row.recipe || "scene");
    const inputProps = row.props ?? {};
    const composition = await selectComposition({
      serveUrl,
      id: "CartoonScene",
      inputProps,
    });
    composition.durationInFrames = 90;
    composition.fps = 30;
    composition.width = 1920;
    composition.height = 1080;
    const output = path.join(outputDir, `${recipe}.mp4`);
    console.log(`[motion-preview] ${recipe} -> ${output}`);
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: output,
      inputProps,
      scale: 0.5,
      videoBitrate: "3M",
      chromiumOptions: { gl: "angle" },
    });
  }
}

main()
  .finally(() => rmSync(bundleDir, { recursive: true, force: true }))
  .catch((err) => {
    console.error("[motion-preview] FATAL:", err);
    process.exit(1);
  });
