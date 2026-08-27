import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { getCompositions, openBrowser, renderStill } from "@remotion/renderer";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("output directory argument is required");
await fs.mkdir(outputDir, { recursive: true });

const serveUrl = await bundle({
  entryPoint: path.resolve("src/test-index.ts"),
  webpackOverride: (config) => config,
});
const browser = await openBrowser("chrome");
try {
  const compositions = await getCompositions(serveUrl, { puppeteerInstance: browser });
  const requested = [
    ["MotionPrimitiveMatrix", 42, "relationships-transform.png"],
    ["MotionPrimitiveMatrix", 96, "relationships-consequence.png"],
    ["SubjectPrimitiveMatrix", 42, "subjects-transform.png"],
    ["SubjectPrimitiveMatrix", 96, "subjects-consequence.png"],
    ["ExplanationBookendRegression", 96, "bookend.png"],
  ];
  const manifest = [];
  for (const [id, frame, filename] of requested) {
    const composition = compositions.find((candidate) => candidate.id === id);
    if (!composition) throw new Error(`missing test composition: ${id}`);
    await renderStill({
      composition,
      serveUrl,
      output: path.join(outputDir, filename),
      frame,
      imageFormat: "png",
      puppeteerInstance: browser,
    });
    manifest.push({ id, frame, filename, width: composition.width, height: composition.height });
  }
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
} finally {
  await browser.close();
}
