import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";

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
  // Pick each fixture's operation from the compatibility contract instead of
  // inheriting one from the bookend defaults. That inherited "group" paired
  // with path and quantity, neither of which production accepts, so these
  // frames exercised combinations a viewer can never receive -- and
  // group/quantity additionally has no numericValue, which the renderer now
  // rejects outright.
  const operationFor = (primitive) => {
    const entry = Object.entries(compatibility).find(([operation, primitives]) =>
      operation !== "payoff" && !primitives.includes("*") && primitives.includes(primitive));
    if (!entry) throw new Error(`no compatible non-payoff operation for ${primitive}`);
    return entry[0];
  };
  for (const primitive of ["network", "path", "quantity"]) {
    const visualOperation = operationFor(primitive);
    requested.push({
      id: "ExplanationBackgroundRegression", frame: 24, filename: `background-${primitive}.png`,
      inputProps: {
        visualPrimitive: primitive,
        visualOperation,
        numericValue: visualOperation === "counter" || primitive === "quantity" ? 73 : null,
      },
      kind: "background", primitive, operation: visualOperation,
    });
  }
  requested.push(
    { id: "ExplanationBookendRegression", frame: 96, filename: "bookend.png", kind: "bookend" },
    { id: "ExplanationEmptyBookendReference", frame: 96, filename: "bookend-empty.png", kind: "bookend-reference" },
    { id: "ExplanationPayoffRegression", frame: 110, filename: "payoff.png", kind: "payoff" },
  );

  const manifest = [];
  for (const request of requested) {
    const inputProps = request.inputProps || {};
    // Props must be resolved per request. getCompositions() resolves them once
    // from defaultProps, and renderStill then draws from that already-resolved
    // composition -- so passing inputProps here did nothing and every page,
    // state and background rendered byte-identical output. The suite was
    // asserting over 64 compatibility cases while only ever rendering the
    // first 16, and comparing hypothesis against a second copy of itself.
    const composition = await selectComposition({
      serveUrl, id: request.id, inputProps, puppeteerInstance: browser,
    });
    if (!composition) throw new Error(`missing test composition: ${request.id}`);
    await renderStill({
      composition, serveUrl, output: path.join(outputDir, request.filename),
      frame: request.frame, imageFormat: "png", puppeteerInstance: browser,
      inputProps,
    });
    manifest.push({ ...request, width: composition.width, height: composition.height });
  }
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ compatibilityCases, allPrimitives, frames: manifest }, null, 2));
} finally {
  await browser.close({ silent: true });
}
