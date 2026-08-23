import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.join(HERE, "..", "prompts", "dialogue_script_writer", "7.md");

test("dialogue_script_writer prompt forbids phone props for planning/lateness unless the topic is about phones", async () => {
  const prompt = await readFile(PROMPT, "utf8");

  assert.match(prompt, /Hard topic-specific prop contract/);
  assert.match(prompt, /planning\/lateness/);
  assert.match(prompt, /`prop=phone` is invalid/);
  assert.match(prompt, /prop=route-map/);
  assert.match(prompt, /prop=calendar/);
  assert.match(prompt, /prop=clock/);
  assert.match(prompt, /phone used for route\/GPS\s*-> prop=route-map/);
  assert.match(prompt, /phone used for schedule\s*-> prop=calendar/);
  assert.match(prompt, /phone used for time\s*-> prop=clock/);
  assert.match(prompt, /If any planning\/lateness scene has `prop=phone`, rewrite that scene before answering/);
});
