import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "src", "workers", "cartoon-scenes.ts"), "utf8");

test("cartoon background catalog includes airplane and engineering environments", () => {
  assert.match(source, /"airplane-cabin": \["day"\]/);
  assert.match(source, /"engineering-lab": \["day"\]/);
});

test("cartoon compiler applies story-aware airplane and mechanism backgrounds", () => {
  assert.match(source, /function topicEnvironment/);
  assert.match(source, /airplane\|plane\|flight\|seat\|window\|cabin/);
  assert.match(source, /pressure\|stress\|crack\|corner\|round\|square\|engineering/);
  assert.match(source, /catalogBackground\("airplane-cabin", "day"\)/);
  assert.match(source, /catalogBackground\("engineering-lab", "day"\)/);
});

test("long cartoon episodes cannot remain in one visible background", () => {
  assert.match(source, /MIN_DYNAMIC_BACKGROUND_SCENES = 13/);
  assert.match(source, /function assertBackgroundVariety/);
  assert.match(source, /Long cartoon episodes require at least two distinct visible environments/);
  assert.match(source, /assertBackgroundVariety\(entries\)/);
});

test("dynamic backgrounds force non-static ambient motion", () => {
  assert.match(source, /preferredAmbientForEnvironment/);
  assert.match(source, /airplane-cabin"\) return "window-light"/);
  assert.match(source, /engineering-lab"\) return "chart-wiggle"/);
});
