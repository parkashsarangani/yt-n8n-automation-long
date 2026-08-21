const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

describe("compose runtime patches", () => {
  it("routes production start through the guarded runtime patcher", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.strictEqual(pkg.main, "compose-runtime.js");
    assert.strictEqual(pkg.scripts.start, "node compose-runtime.js");
  });

  it("forwards cartoon direction props into CartoonScene", () => {
    const runtime = fs.readFileSync(path.join(ROOT, "compose-runtime.js"), "utf8");
    assert.match(runtime, /visualEvent: d\.visualEvent/);
    assert.match(runtime, /speakerEmphasis: d\.speakerEmphasis/);
  });

  it("preserves per-scene audio timing for cartoon lip sync", () => {
    const runtime = fs.readFileSync(path.join(ROOT, "compose-runtime.js"), "utf8");
    assert.match(runtime, /preserveSceneAudioForLipSync/);
    assert.match(runtime, /scene\?\.visual_source === "template" && scene\?\.template_name === "cartoon"/);
    assert.match(runtime, /const voiceLabel = preserveSceneAudioForLipSync \? "0:a" : "1:a"/);
    assert.ok(!/buildGaplessVoice[\s\S]*const voiceLabel = "1:a"/.test(runtime));
  });
});
