import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const graph = JSON.parse(readFileSync(new URL("../graphs/cartoon.json", import.meta.url), "utf8"));
const promptInputs = readFileSync(new URL("../src/prompt-inputs.ts", import.meta.url), "utf8");
const cast = JSON.parse(readFileSync(new URL("../config/cast_roster.default.json", import.meta.url), "utf8"));

test("cartoon graph revises and independently re-scores before deterministic release", () => {
  const ids = graph.nodes.map((node: { id: string }) => node.id);
  assert.ok(ids.indexOf("retention_edit") < ids.indexOf("quality_draft"));
  assert.ok(ids.indexOf("quality_draft") < ids.indexOf("quality_revision"));
  assert.ok(ids.indexOf("quality_revision") < ids.indexOf("quality_final"));
  assert.ok(ids.indexOf("quality_final") < ids.indexOf("quality_release"));
  assert.deepEqual(graph.nodes.find((node: { id: string }) => node.id === "approve_script").in, ["quality_release"]);
});

test("prompt views preserve actual dialogue identity and character-bible fields", () => {
  assert.match(promptInputs, /speaker: obj\.speaker/);
  assert.match(promptInputs, /emotion: obj\.emotion/);
  for (const token of ['"worldview"', '"comic_style"', '"speech_rhythm"', '"blind_spot"', '"relationship_dynamic"']) {
    assert.match(promptInputs, new RegExp(token));
  }
  for (const character of cast.characters) {
    for (const field of ["worldview", "comic_style", "speech_rhythm", "strength", "blind_spot", "scene_drive", "relationship_dynamic"]) {
      assert.ok(character[field]?.length > 10, `${character.character_id} needs ${field}`);
    }
  }
});
