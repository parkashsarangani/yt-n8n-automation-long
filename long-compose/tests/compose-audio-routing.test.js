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

  it("preserves scene-timed audio for cartoon and explanation character lip sync", () => {
    assert.match(source, /preserveSceneAudioForLipSync/);
    assert.match(source, /\["cartoon", "explanation"\]\.includes\(scene\?\.template_name\)/);
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
    // The final map used to inline this decision as a ternary on
    // mixLabels.length. It is now a variable, because the limiter can build
    // [final_a] even when the voice is the only thing in the mix -- the
    // ternary would then have mapped the raw voice and silently dropped the
    // limiter. Same guarantee, expressed where every branch can set it.
    assert.match(source, /let finalAudioLabel = voiceLabel;/);
    assert.match(source, /"-map", finalAudioLabel,/);
    assert.match(source, /finalAudioLabel = "\[final_a\]";/);
  });
});
