/**
 * Unit tests for the caption speaker-attribution helpers in compose.js
 * (hexToAssColor, and the per-scene color/name-tag line construction).
 *
 * compose.js starts Express on require, so - matching helpers.test.js's own
 * convention - the small pure logic is recreated here rather than imported.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

// Recreated from compose.js's hexToAssColor.
function hexToAssColor(hex) {
  const m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(String(hex ?? ""));
  if (!m) return "&H00FFFFFF";
  const [, r, g, b] = m;
  return `&H00${b}${g}${r}`.toUpperCase();
}

// Recreated from compose.js's escapeAssText.
function escapeAssText(value) {
  return String(value ?? "")
    .replace(/\\/g, "＼")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

// Recreated from buildAssFromAlignment's per-scene speaker tag construction.
function speakerPrefix(scene, phraseStart) {
  const speakerName = typeof scene?.speaker_name === "string" ? scene.speaker_name.trim() : "";
  const speakerColorTag = speakerName ? `{\\1c${hexToAssColor(scene.speaker_color)}}` : "";
  let line = speakerColorTag;
  if (speakerName && phraseStart === 0) {
    line += `${escapeAssText(speakerName.toUpperCase())}: `;
  }
  return line;
}

describe("hexToAssColor", () => {
  it("converts #RRGGBB to ASS's &H00BBGGRR (byte-reversed)", () => {
    assert.strictEqual(hexToAssColor("#4C89C6"), "&H00C6894C");
  });

  it("falls back to white for a missing or malformed color", () => {
    assert.strictEqual(hexToAssColor(undefined), "&H00FFFFFF");
    assert.strictEqual(hexToAssColor(""), "&H00FFFFFF");
    assert.strictEqual(hexToAssColor("not-a-color"), "&H00FFFFFF");
    assert.strictEqual(hexToAssColor("#ZZZZZZ"), "&H00FFFFFF");
  });
});

describe("caption speaker attribution", () => {
  it("tags the first phrase of a scene with the speaker's name and color", () => {
    const scene = { speaker_name: "Host", speaker_color: "#4C89C6" };
    const prefix = speakerPrefix(scene, 0);
    assert.match(prefix, /^\{\\1c&H00C6894C\}HOST: $/);
  });

  it("colors continuation phrases but does not repeat the name", () => {
    const scene = { speaker_name: "Host", speaker_color: "#4C89C6" };
    const prefix = speakerPrefix(scene, 8);
    assert.strictEqual(prefix, "{\\1c&H00C6894C}");
  });

  it("adds nothing when the scene has no speaker (legacy/manual renders)", () => {
    assert.strictEqual(speakerPrefix({}, 0), "");
    assert.strictEqual(speakerPrefix(undefined, 0), "");
  });

  it("escapes ASS control characters in a speaker name", () => {
    const scene = { speaker_name: "H{o}st\\", speaker_color: "#4C89C6" };
    const prefix = speakerPrefix(scene, 0);
    assert.ok(!prefix.includes("{o}"), "raw brace from the name must not reach the ASS line");
    assert.match(prefix, /H\(O\)ST/);
  });

  it("gives different characters visibly different colors", () => {
    const host = hexToAssColor("#4C89C6");
    const buddy = hexToAssColor("#F2C7A5");
    assert.notStrictEqual(host, buddy);
  });
});
