import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cartoon studio UI is cartoon-first and exposes the recurring cast", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  assert.match(html, /Cartoon Channel Studio/);
  assert.match(html, /Create cartoon episode/);
  assert.match(html, /Recurring cast/);
  assert.match(html, /Haven Sands/);
  assert.match(html, /x8xv0H8Ako6Iw3cKXLoC/);
  assert.match(html, /Alex/);
  assert.match(html, /yl2ZDV1MzN4HbQJbMihG/);
  assert.doesNotMatch(html, /Animated cartoon \(dialogue\)/);
  assert.doesNotMatch(html, /stock imagery/);
  assert.match(html, /\/api\/runs/);
  assert.match(html, /\/api\/discover/);
});

test("canonical default cast carries production ElevenLabs voice ids", async () => {
  const cast = JSON.parse(
    await readFile(path.join(ROOT, "config", "cast_roster.default.json"), "utf8"),
  ) as {
    characters: Array<{ character_id: string; voice_id: string }>;
    default_voice_id: string;
  };

  const host = cast.characters.find((c) => c.character_id === "host");
  const buddy = cast.characters.find((c) => c.character_id === "buddy");

  assert.equal(host?.voice_id, "x8xv0H8Ako6Iw3cKXLoC");
  assert.equal(buddy?.voice_id, "yl2ZDV1MzN4HbQJbMihG");
  assert.equal(cast.default_voice_id, host?.voice_id);
});
