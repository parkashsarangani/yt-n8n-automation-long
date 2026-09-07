import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface GraphNode {
  id: string;
  type?: string;
  transformation?: string;
  in?: string[];
}

interface GraphFile {
  graph_id: string;
  nodes: GraphNode[];
}

const ENGINE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_DIR = path.join(ENGINE_ROOT, "graphs");

test("every graph that executes the production voice worker is structurally gated by tts_moderation", async () => {
  const files = (await readdir(GRAPH_DIR)).filter((name) => name.endsWith(".json")).sort();
  const checked: string[] = [];

  for (const file of files) {
    const graph = JSON.parse(await readFile(path.join(GRAPH_DIR, file), "utf8")) as GraphFile;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const voiceNodes = graph.nodes.filter((node) => node.transformation === "voice");

    for (const voice of voiceNodes) {
      checked.push(`${graph.graph_id}:${voice.id}`);
      const inputs = voice.in ?? [];
      const moderationInputs = inputs
        .map((id) => byId.get(id))
        .filter((node): node is GraphNode => node?.transformation === "tts_moderation");

      assert.equal(
        moderationInputs.length,
        1,
        `${graph.graph_id}:${voice.id} must consume exactly one tts_moderation node`,
      );
      const moderation = moderationInputs[0]!;
      assert.ok(
        (moderation.in ?? []).length > 0,
        `${graph.graph_id}:${moderation.id} must consume the same script lineage before voice synthesis`,
      );
    }
  }

  assert.ok(checked.length > 0, "expected at least one graph to execute the voice worker");
});
