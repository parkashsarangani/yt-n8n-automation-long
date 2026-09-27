import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("studio UI reflects the audio-first format, not the retired visual pipelines", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  assert.match(html, /Narrated Story Studio/);
  assert.match(html, /Season episode/);
  assert.match(html, /Custom episode/);
  assert.match(html, /\/api\/runs/);

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

test("the studio offers exactly two creators: a season episode and a custom script", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");

  // Season dropdown, driven by the catalog, starting through the series route.
  assert.match(html, /id="seriesEpisode"/);
  assert.match(html, /\/api\/series\//);

  // Custom episode: length, hook and script only. The title is derived from
  // the hook server-side, so the form must not ask for one.
  for (const id of ["customLength", "customHook", "customScript", "startCustom"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing custom-episode field: ${id}`);
  }
  assert.match(html, /\/api\/runs\/manual/);
  assert.match(html, /duration_sec:Math\.round\(minutes\*60\)/);
  assert.doesNotMatch(html, /manualTitle/);

  // Retired: free-form idea brief, story types and discovery suggestions.
  assert.doesNotMatch(html, /\/api\/discover/);
  assert.doesNotMatch(html, /id="brief"|id="genre"|Suggest episode ideas|The Turning Point/);
});

test("the editor's-cut gate is never approved by hand from the studio", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");
  // Approving editor_review would publish the unedited render. The studio
  // links the Drive folder and triggers a Drive check instead.
  assert.match(html, /drive_folder_url/);
  assert.match(html, /\/api\/schedule\/editor_watch\/run/);
  assert.doesNotMatch(html, /data-node="editor_review"/);
});
