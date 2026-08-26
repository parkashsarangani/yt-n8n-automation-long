import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Filename kept as "v8" for history: these naturalness protections were first
// introduced in prompt v8 after a real production render came out sounding
// AI-generated. This file's job is to confirm they survive every subsequent
// prompt rewrite, not to freeze the prompt at v8 -- so it always reads
// whichever prompt file the agent config currently points to.
const agent = readFileSync(new URL("../agents/dialogue_script_writer.json", import.meta.url), "utf8");
const activeVersion = /"prompt":\s*"dialogue_script_writer@(\d+)"/.exec(agent)?.[1];
if (!activeVersion) throw new Error("could not read dialogue_script_writer's active prompt version from agents/dialogue_script_writer.json");
const prompt = readFileSync(new URL(`../prompts/dialogue_script_writer/${activeVersion}.md`, import.meta.url), "utf8");

test("dialogue writer agent version and prompt reference stay in sync", () => {
  assert.match(agent, new RegExp(`"version":\\s*"${activeVersion}"`));
});

test("the active prompt still blocks the unnatural patterns seen in the doorway render", () => {
  assert.match(prompt, /repeating the same phrase three times/);
  assert.match(prompt, /lines ending in `\.\.\.`/);
  assert.match(prompt, /is called/);
  assert.match(prompt, /actually tested this/);
});
