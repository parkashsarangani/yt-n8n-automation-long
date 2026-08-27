/**
 * Caption identity tests. Speaker identity is carried by color, never by a
 * viewer-facing HOST:/BUDDY: production prefix.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert");

function hexToAssColor(hex) {
  const m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(String(hex ?? ""));
  if (!m) return "&H00FFFFFF";
  const [, r, g, b] = m;
  return `&H00${b}${g}${r}`.toUpperCase();
}

function speakerColorPrefix(scene) {
  const hasSpeaker = typeof scene?.speaker_name === "string" && scene.speaker_name.trim().length > 0;
  return hasSpeaker ? `{\\1c${hexToAssColor(scene.speaker_color)}}` : "";
}

describe("hexToAssColor", () => {
  it("converts #RRGGBB to ASS byte order", () => {
    assert.strictEqual(hexToAssColor("#4C89C6"), "&H00C6894C");
  });

  it("falls back to white for malformed colors", () => {
    assert.strictEqual(hexToAssColor(undefined), "&H00FFFFFF");
    assert.strictEqual(hexToAssColor("not-a-color"), "&H00FFFFFF");
  });
});

describe("caption speaker identity", () => {
  it("uses color without rendering the speaker name", () => {
    const scene = { speaker_name: "Host", speaker_color: "#4C89C6" };
    const prefix = speakerColorPrefix(scene);
    assert.strictEqual(prefix, "{\\1c&H00C6894C}");
    assert.ok(!prefix.includes("HOST"));
    assert.ok(!prefix.includes(":"));
  });

  it("adds nothing for legacy scenes without a speaker", () => {
    assert.strictEqual(speakerColorPrefix({}), "");
    assert.strictEqual(speakerColorPrefix(undefined), "");
  });

  it("keeps recurring characters visibly distinct", () => {
    assert.notStrictEqual(hexToAssColor("#4C89C6"), hexToAssColor("#F2C7A5"));
  });
});
