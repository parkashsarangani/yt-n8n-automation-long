const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("all relationship primitives render as pixels at transformation and consequence phases", { timeout: 180000 }, () => {
  const remotionDir = path.join(__dirname, "../remotion");
  const executable = path.join(remotionDir, "node_modules/.bin/remotion");
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-matrix-"));
  try {
    for (const frame of [42, 96]) {
      const output = path.join(outputDir, `matrix-${frame}.png`);
      const result = spawnSync(executable, [
        "still",
        "src/index.ts",
        "MotionPrimitiveMatrix",
        output,
        `--frame=${frame}`,
        "--log=error",
        "--overwrite",
      ], { cwd: remotionDir, encoding: "utf8", timeout: 85000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const stats = fs.statSync(output);
      assert.ok(stats.size > 20_000, `rendered frame ${frame} is unexpectedly empty (${stats.size} bytes)`);
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
