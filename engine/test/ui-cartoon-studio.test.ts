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
  assert.match(html, /6OzrBCQf8cjERkYgzSg8/);
  assert.match(html, /Alex/);
  assert.match(html, /EOVAuWqgSZN2Oel78Psj/);
  assert.doesNotMatch(html, /Animated cartoon \(dialogue\)/);
  assert.doesNotMatch(html, /stock imagery/);
  assert.match(html, /\/api\/runs/);
  assert.match(html, /\/api\/discover/);
});

test("Studio progress mirrors the lean explanation-first production graph", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  for (const label of [
    "Dialogue draft",
    "Entertainment edit",
    "Script critique",
    "Targeted script revision",
    "Release script",
    "Plan visual operations",
    "Compile animated scenes",
    "Render motion-graphics episode",
    "Output release check",
  ]) {
    assert.match(html, new RegExp(label));
  }

  assert.match(html, /Explanation-first motion graphics/);
  assert.doesNotMatch(html, /script:"Dialogue script"/);
  assert.doesNotMatch(html, /visual_plan:"Shot direction"/);
  assert.doesNotMatch(html, /Dialogue-driven cartoon animation/);
});

test("episode idea suggestions unwrap the topic_candidates artifact shape", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  // /api/discover returns the topic_candidates artifact payload under
  // r.candidates. That payload is { basis, candidates: [...] }, not an array.
  assert.match(html, /Array\.isArray\(set\?\.candidates\)\?set\.candidates/);
  assert.match(html, /why_it_earns_attention/);
  assert.match(html, /obj\.novelty/);
  assert.match(html, /r\.history_count/);
  assert.match(html, /r\.measured_episodes/);

  // Selecting a suggestion must seed production with the candidate's brief,
  // while the UI may display its shorter angle/rationale.
  assert.match(html, /brief=obj\.brief\|\|obj\.topic\|\|obj\.title/);
  assert.match(html, /data-idea="\$\{esc\(brief\)\}"/);
  assert.match(html, /\$\("brief"\)\.value=b\.dataset\.idea/);

  // Discovery can take a while; prevent duplicate requests and restore the
  // button even when the provider fails.
  assert.match(html, /btn\.disabled=true/);
  assert.match(html, /finally\{btn\.disabled=false;btn\.textContent=label\}/);
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

  assert.equal(host?.voice_id, "6OzrBCQf8cjERkYgzSg8");
  assert.equal(buddy?.voice_id, "EOVAuWqgSZN2Oel78Psj");
  assert.equal(cast.default_voice_id, host?.voice_id);
});
