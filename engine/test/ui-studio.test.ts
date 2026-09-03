import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("studio UI reflects the illustrated-story format, not the retired character pipeline", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  assert.match(html, /Illustrated Story Studio/);
  assert.match(html, /Create episode/);
  assert.match(html, /No characters, no dialogue/);
  assert.doesNotMatch(html, /Cartoon Channel Studio/);
  assert.doesNotMatch(html, /Recurring cast/);
  assert.doesNotMatch(html, /Host \+ Buddy/);
  assert.match(html, /\/api\/runs/);
  assert.match(html, /\/api\/discover/);
});

test("Studio progress mirrors the illustrated-story production graph", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  for (const label of [
    "Narration draft",
    "Watchability critique",
    "Release script",
    "Shot list",
    "Generate illustrated stills",
    "Render episode",
    "Output release check",
  ]) {
    assert.match(html, new RegExp(label));
  }

  assert.doesNotMatch(html, /Dialogue draft/);
  assert.doesNotMatch(html, /Entertainment edit/);
  assert.doesNotMatch(html, /Compile animated scenes/);
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
