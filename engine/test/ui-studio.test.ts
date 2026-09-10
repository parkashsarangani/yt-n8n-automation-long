import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("studio UI reflects the audio-first format, not the retired visual pipelines", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  assert.match(html, /Narrated Story Studio/);
  assert.match(html, /Create episode/);
  assert.match(html, /Single-narrator voice-over/);
  assert.match(html, /\/api\/runs/);
  assert.match(html, /\/api\/discover/);

  // Retired character pipeline.
  assert.doesNotMatch(html, /Cartoon Channel Studio/);
  assert.doesNotMatch(html, /Recurring cast/);
  assert.doesNotMatch(html, /Host \+ Buddy/);

  // Retired illustrated/RFC 0010 visual stack. The operator must not be
  // offered an art-direction knob no worker reads any more.
  assert.doesNotMatch(html, /Illustrated Story Studio/);
  assert.doesNotMatch(html, /Image style/i);
  assert.doesNotMatch(html, /image_style/);
  assert.doesNotMatch(html, /ink_wash_stickman|flat_comic_expressive|documentary_sketch|watercolor_storybook|noir_charcoal/);
});

test("Studio progress mirrors the audio-first production graph", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  for (const label of [
    "Growth package",
    "Story outline",
    "Narration draft",
    "Watchability critique",
    "Release script",
    "Narration safety screen",
    "Generate narration voice",
    "Thumbnail artwork",
    "Render episode",
    "Output release check",
    "Publish to YouTube",
  ]) {
    assert.match(html, new RegExp(label), `missing stage label: ${label}`);
  }

  // Retired character pipeline.
  assert.doesNotMatch(html, /Dialogue draft/);
  assert.doesNotMatch(html, /Entertainment edit/);
  assert.doesNotMatch(html, /Compile animated scenes/);

  // Retired visual stack: no stage may be labelled for a node the audio-first
  // graph no longer contains.
  assert.doesNotMatch(html, /Shot list/);
  assert.doesNotMatch(html, /Generate illustrated stills/);
  assert.doesNotMatch(html, /episode_director|illustrated_scene_assets|visual_director/);
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
