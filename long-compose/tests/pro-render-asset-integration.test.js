const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const cartoonScene = readFileSync(join(root, "remotion/src/compositions/CartoonScene.tsx"), "utf8");
const propAsset = readFileSync(join(root, "remotion/src/components/PropAsset.tsx"), "utf8");
const registry = readFileSync(join(root, "remotion/src/lib/assetRegistry.ts"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "remotion/public/assets/manifest.json"), "utf8"));

test("CartoonScene consumes scene composition and cinematic blocking before conversation direction", () => {
  assert.match(cartoonScene, /composeCharactersForScene/);
  assert.match(cartoonScene, /const stagedCharacters = useMemo/);
  assert.match(cartoonScene, /withCinematicRecipeBlocking\(stagedCharacters, cinematic\)/);
  assert.match(cartoonScene, /withConversationDirection\(recipeBlockedCharacters, speakerEmphasis\)/);
  assert.match(cartoonScene, /foregroundMaskForScene/);
});

test("CartoonScene uses asset-backed props instead of hand-authored prop branches", () => {
  assert.match(cartoonScene, /<PropAsset/);
  for (const oldBranch of [
    'if (type === "keys")',
    'if (type === "laptop")',
    'if (type === "calendar")',
    'if (type === "coffee"',
    'if (type === "document")',
    'if (type === "vehicle"',
  ]) {
    assert.equal(cartoonScene.includes(oldBranch), false, `${oldBranch} should not remain in CartoonScene`);
  }
});

test("production prop pack is vendored locally from permissive Iconify-compatible sources", () => {
  const required = [
    "phone-charger",
    "keys",
    "laptop",
    "calendar",
    "clock",
    "coffee",
    "document",
    "map",
    "bed",
    "car",
    "kettle",
    "food",
    "shoes",
    "window",
    "door",
    "tool",
    "appliance",
  ];

  for (const name of required) {
    const path = `assets/props/iconify/${name}.svg`;
    assert.ok(existsSync(join(root, "remotion/public", path)), `${name} SVG should be vendored`);
    assert.ok(manifest.assets.some((asset) => asset.path === path && asset.status === "vendored-third-party"), `${name} should be manifest-listed as vendored-third-party`);
  }
});

test("asset registry resolves common foreground prop aliases", () => {
  assert.match(registry, /resolvePropAsset/);
  for (const alias of ["charger", "keys", "laptop", "calendar", "clock", "mug", "document", "route-map", "bed", "vehicle", "kettle", "food", "shoes", "window", "door", "tool", "appliance", "device"]) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(registry, new RegExp(`(?:^|\\n)\\s*\"?${escaped}\"?:\\s*\"prop:`), `${alias} alias should be mapped`);
  }
});

test("PropAsset renders local files only and has deterministic fallback", () => {
  assert.match(propAsset, /resolvePropAsset/);
  assert.match(propAsset, /staticFile\(asset\.source\.path\)/);
  assert.match(propAsset, /data-prop-asset=\{asset\?\.key/);
  assert.match(propAsset, /FALLBACK_GLYPH_BY_TYPE/);
  assert.match(propAsset, /fallback-glyph/);
  assert.doesNotMatch(propAsset, /fetch\(|axios|https?:\/\//);
});

test("render asset policy remains local-only", () => {
  assert.equal(manifest.policy.runtimeNetworkAccess, false);
  for (const asset of manifest.assets.filter((entry) => entry.path)) {
    assert.equal(/^https?:\/\//.test(asset.path), false, `${asset.key} must not use a remote render path`);
  }
});
