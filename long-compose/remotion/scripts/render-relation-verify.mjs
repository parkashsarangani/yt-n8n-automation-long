// Ad-hoc verification harness for explanation_plan@1.5.0 model_relations.
//
// The motion-design-render regression suite renders every production-valid
// operation/primitive pair, but every one of those fixtures has an empty
// relation list -- so it only ever exercises the pre-1.5.0 fallback topology.
// This renders the AUTHORED path: each relation kind on its own frame, plus
// the mixed graph and the no-relations fallback for comparison.
//
// Usage: node scripts/render-relation-verify.mjs <outputDir>
import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("output directory argument is required");
await fs.mkdir(outputDir, { recursive: true });

const base = {
  role: "diagram-build",
  visualOperation: "group",
  visualPrimitive: "network",
  visualState: "mechanism",
  compositionMode: "full-model",
  characterCutIn: "none",
  characters: [],
  title: "",
  keyText: "",
  before: "",
  after: "",
  numericValue: null,
  elements: ["warm air", "updraft", "cloud deck", "rainfall"],
  entityIdentityKeys: ["warm air", "updraft", "cloud deck", "rainfall"],
};

const cases = [
  { name: "kind-causes", relations: [{ from: 0, to: 1, kind: "causes" }] },
  { name: "kind-blocks", relations: [{ from: 0, to: 1, kind: "blocks" }] },
  { name: "kind-becomes", relations: [{ from: 0, to: 1, kind: "becomes" }] },
  { name: "kind-feeds", relations: [{ from: 0, to: 1, kind: "feeds" }] },
  { name: "kind-contains", relations: [{ from: 0, to: 1, kind: "contains" }] },
  {
    name: "mixed-four-entity",
    relations: [
      { from: 0, to: 1, kind: "causes" },
      { from: 1, to: 2, kind: "feeds" },
      { from: 2, to: 3, kind: "becomes" },
      { from: 3, to: 0, kind: "blocks" },
    ],
  },
  { name: "three-entity", elements: base.elements.slice(0, 3), relations: [
    { from: 0, to: 1, kind: "causes" },
    { from: 1, to: 2, kind: "blocks" },
  ] },
  // The control: identical scene with no authored relations must still render
  // the previous fixed seven-node topology, not a blank frame.
  { name: "fallback-no-relations", relations: [] },
];

const serveUrl = await bundle({ entryPoint: path.resolve("src/test-index.ts"), webpackOverride: (config) => config });
const browser = await openBrowser("chrome");
try {
  for (const testCase of cases) {
    const elements = testCase.elements ?? base.elements;
    const inputProps = {
      ...base,
      elements,
      entityIdentityKeys: elements,
      modelRelations: testCase.relations,
    };
    const composition = await selectComposition({ serveUrl, id: "ExplanationBookendRegression", inputProps, puppeteerInstance: browser });
    for (const frame of [50, 100]) {
      const output = path.join(outputDir, `${testCase.name}-f${frame}.png`);
      await renderStill({ composition, serveUrl, output, frame, inputProps, puppeteerInstance: browser, overwrite: true });
      console.log("rendered", output);
    }
  }
} finally {
  await browser.close({ silent: true });
}
