import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { getCompositions, openBrowser, renderStill } from "@remotion/renderer";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("output directory argument is required");
await fs.mkdir(outputDir, { recursive: true });
const compatibility = JSON.parse(await fs.readFile(path.resolve("src/motion-compatibility.json"), "utf8"));
const compatibilityCases = Object.entries(compatibility).flatMap(([operation, primitives]) =>
  primitives.map((primitive) => ({ operation, primitive }))
);
const allPrimitives = [...new Set(compatibilityCases.map((item) => item.primitive))];
const perPage = 16;

const serveUrl = await bundle({ entryPoint: path.resolve("src/test-index.ts"), webpackOverride: (config) => config });
const browser = await openBrowser("chrome");
try {
  const compositions = await getCompositions(serveUrl, { puppeteerInstance: browser });
  const requested = [];
  for (let page = 0; page < Math.ceil(compatibilityCases.length / perPage); page++) {
    for (const frame of [42, 96]) requested.push({
      id: "MotionCompatibilityMatrix", frame, filename: `compatibility-${page}-${frame}.png`,
      inputProps: { page }, kind: "compatibility", page,
      cases: compatibilityCases.slice(page * perPage, (page + 1) * perPage),
    });
  }
  for (let page = 0; page < Math.ceil(allPrimitives.length / perPage); page++) {
    for (const state of ["hypothesis", "contradiction"]) requested.push({
      id: "PrimitiveStateMatrix", frame: 96, filename: `state-${page}-${state}.png`,
      inputProps: { page, state }, kind: "state", page, state,
      primitives: allPrimitives.slice(page * perPage, (page + 1) * perPage),
    });
  }
  for (const primitive of ["network", "path", "quantity"]) requested.push({
    id: "ExplanationBackgroundRegression", frame: 24, filename: `background-${primitive}.png`,
    inputProps: { visualPrimitive: primitive }, kind: "background", primitive,
  });
  requested.push(
    { id: "ExplanationBookendRegression", frame: 96, filename: "bookend.png", kind: "bookend" },
    { id: "ExplanationEmptyBookendReference", frame: 96, filename: "bookend-empty.png", kind: "bookend-reference" },
    { id: "ExplanationPayoffRegression", frame: 110, filename: "payoff.png", kind: "payoff" },
  );

  const manifest = [];
  for (const request of requested) {
    const composition = compositions.find((candidate) => candidate.id === request.id);
    if (!composition) throw new Error(`missing test composition: ${request.id}`);
    await renderStill({
      composition, serveUrl, output: path.join(outputDir, request.filename),
      frame: request.frame, imageFormat: "png", puppeteerInstance: browser,
      inputProps: request.inputProps || {},
    });
    manifest.push({ ...request, width: composition.width, height: composition.height });
  }
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ compatibilityCases, allPrimitives, frames: manifest }, null, 2));
} finally {
  await browser.close({ silent: true });
}
