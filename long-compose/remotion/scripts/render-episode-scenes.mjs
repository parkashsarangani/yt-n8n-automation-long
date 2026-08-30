// Renders the exact scenes from a real episode's visual plan, so a change to
// the primitives can be judged against what production actually produced
// rather than against invented fixtures.
//
// The scenes below are run_a41a8e2e ("Why does a thermos keep a drink hot?"),
// the episode where 8 of 21 scenes drew no authored entity at all and four
// nested-context scenes rendered as the same picture.
//
// Usage: node scripts/render-episode-scenes.mjs <outputDir>
import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("output directory argument is required");
await fs.mkdir(outputDir, { recursive: true });

const SCENES = [
  { i: 2, primitive: "nested-context", operation: "group", state: "contradiction",
    elements: ["thermos", "vacuum gap", "thick walls"],
    relations: [{ from: 0, to: 1, kind: "contains" }] },
  { i: 9, primitive: "nested-context", operation: "group", state: "mechanism",
    elements: ["vacuum gap", "conduction", "heat loss"],
    relations: [{ from: 0, to: 1, kind: "blocks" }, { from: 1, to: 2, kind: "causes" }] },
  { i: 6, primitive: "path", operation: "timeline", state: "mechanism",
    elements: ["coffee", "thermos wall", "heat token"],
    relations: [{ from: 0, to: 2, kind: "feeds" }, { from: 2, to: 1, kind: "causes" }] },
  { i: 14, primitive: "rays", operation: "timeline", state: "mechanism",
    elements: ["infrared", "silvered wall", "coffee"],
    relations: [{ from: 1, to: 0, kind: "blocks" }, { from: 0, to: 2, kind: "feeds" }] },
  { i: 12, primitive: "overlapping-sets", operation: "group", state: "mechanism",
    elements: ["conduction", "convection", "vacuum gap"],
    relations: [{ from: 2, to: 0, kind: "blocks" }, { from: 2, to: 1, kind: "blocks" }] },
  { i: 3, primitive: "shells", operation: "stack", state: "contradiction",
    elements: ["inner wall", "vacuum gap", "outer wall"], relations: [] },
];

const base = {
  role: "diagram-build",
  compositionMode: "full-model",
  characterCutIn: "none",
  characters: [],
  title: "",
  keyText: "",
  before: "",
  after: "",
  numericValue: null,
};

const serveUrl = await bundle({ entryPoint: path.resolve("src/test-index.ts"), webpackOverride: (config) => config });
const browser = await openBrowser("chrome");
try {
  for (const scene of SCENES) {
    const inputProps = {
      ...base,
      visualPrimitive: scene.primitive,
      visualOperation: scene.operation,
      visualState: scene.state,
      elements: scene.elements,
      entityIdentityKeys: scene.elements,
      modelRelations: scene.relations,
    };
    const composition = await selectComposition({ serveUrl, id: "ExplanationBookendRegression", inputProps, puppeteerInstance: browser });
    const output = path.join(outputDir, `scene${String(scene.i).padStart(2, "0")}-${scene.primitive}.png`);
    await renderStill({ composition, serveUrl, output, frame: 100, inputProps, puppeteerInstance: browser, overwrite: true });
    console.log("rendered", output);
  }
} finally {
  await browser.close({ silent: true });
}
