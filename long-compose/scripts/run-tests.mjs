// Splits the test suite into the fast source-contract files and the slow
// render files, so CI can report a broken contract in seconds instead of
// after minutes of Remotion bundling and ffmpeg encoding.
//
// The split is by EXCLUSION, deliberately. Listing the fast files explicitly
// would mean a newly added test file is silently skipped by CI until someone
// remembers to register it -- a test that never runs is worse than no test,
// because it reads as coverage. Only the known-slow files are named here;
// everything else in tests/ is picked up automatically.
//
// `npm test` still runs the whole suite in one go and is unaffected.
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");

// Measured on a real CI run: these two account for essentially all of the
// suite's wall clock (321s of a 509s job). motion-design-render bundles
// Remotion and renders the full operation/primitive matrix as stills;
// output-quality drives real ffmpeg encodes end to end.
const RENDER_SUITES = new Set([
  "motion-design-render.test.js",
  "output-quality.test.js",
]);

// `contracts` = everything fast, `render` = both slow suites, or name one
// slow suite to run it alone. CI runs the two slow suites as separate
// parallel jobs on separate runners: they are CPU-bound renders, so splitting
// them across machines actually halves the tail, where splitting them within
// one runner does not (node --test already spreads files across its cores).
const mode = process.argv[2];
const single = RENDER_SUITES.has(mode) ? mode : null;
if (!single && mode !== "render" && mode !== "contracts") {
  console.error(`usage: run-tests.mjs <contracts|render|${[...RENDER_SUITES].join("|")}>`);
  process.exit(2);
}

const all = readdirSync(testsDir).filter((name) => name.endsWith(".test.js")).sort();
const missing = [...RENDER_SUITES].filter((name) => !all.includes(name));
if (missing.length > 0) {
  // A renamed or deleted render suite would otherwise quietly fall into the
  // "contracts" set and blow its runtime out, or vanish from CI entirely.
  console.error(`run-tests.mjs: named render suite(s) no longer exist: ${missing.join(", ")}`);
  process.exit(2);
}

const selected = single
  ? all.filter((name) => name === single)
  : all.filter((name) => (mode === "render" ? RENDER_SUITES.has(name) : !RENDER_SUITES.has(name)));
if (selected.length === 0) {
  console.error(`run-tests.mjs: no test files matched mode "${mode}"`);
  process.exit(2);
}

console.log(`running ${selected.length} ${mode} test file(s):\n  ${selected.join("\n  ")}`);
const child = spawn(
  process.execPath,
  ["--test", ...selected.map((name) => path.join("tests", name))],
  { cwd: root, stdio: "inherit" },
);
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
