import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("../prompts/dialogue_script_writer/8.md", import.meta.url), "utf8");
const agent = readFileSync(new URL("../agents/dialogue_script_writer.json", import.meta.url), "utf8");

test("dialogue writer uses v8 naturalness prompt", () => {
  assert.match(agent, /"version":\s*"8"/);
  assert.match(agent, /"prompt":\s*"dialogue_script_writer@8"/);
});

test("v8 prompt blocks the unnatural patterns seen in the doorway render", () => {
  assert.match(prompt, /repeating the same phrase three times/);
  assert.match(prompt, /lines ending in `\.\.\.`/);
  assert.match(prompt, /is called/);
  assert.match(prompt, /actually tested this/);
  assert.match(prompt, /Phone charger\. Phone charger\. Phone charger\./);
});

test("v8 prompt tells doorway topics to treat doors as set beats", () => {
  assert.match(prompt, /door is a scene\/set element/);
  assert.match(prompt, /crossing, opening, or leaving through the doorway/);
  assert.match(prompt, /not as a giant foreground object/);
});
