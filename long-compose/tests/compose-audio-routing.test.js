const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "compose.js"), "utf8");

describe("compose cartoon render routing", () => {
  it("forwards cartoon direction props into CartoonScene permanently", () => {
    const cartoonBlock = source.match(/cartoon:\s*\{[\s\S]*?compositionId:\s*"CartoonScene"[\s\S]*?buildProps:\s*\(d\)\s*=>\s*\(\{[\s\S]*?\}\),\s*\},/);
    assert.ok(cartoonBlock, "expected a cartoon category buildProps block in compose.js");
    assert.match(cartoonBlock[0], /visualEvent:\s*d\.visualEvent/);
    assert.match(cartoonBlock[0], /speakerEmphasis:\s*d\.speakerEmphasis/);
  });

  it("preserves scene-timed audio for cartoon lip sync", () => {
    assert.match(source, /preserveSceneAudioForLipSync/);
    assert.match(source, /scene\?\.visual_source === "template" && scene\?\.template_name === "cartoon"/);
    assert.match(source, /if \(!preserveSceneAudioForLipSync\) \{[\s\S]*buildGaplessVoice/);
    assert.match(source, /const voiceLabel = preserveSceneAudioForLipSync \? "0:a" : "1:a"/);
    assert.match(source, /const mixLabels = \[voiceLabel\]/);
    // ffmpeg filtergraph syntax is [in1][in2]filtername=args - the inputs
    // necessarily precede the filter name, so voiceLabel appears before
    // "sidechaincompress" in valid syntax, not after. Check both facts
    // independently instead of assuming a substring order that valid ffmpeg
    // syntax can't produce.
    assert.match(source, /sidechaincompress/);
    assert.match(source, /\[music\]\[\$\{voiceLabel\}\]sidechaincompress/);
    assert.match(source, /"-map", mixLabels\.length > 1 \? "\[final_a\]" : voiceLabel/);
  });
});
