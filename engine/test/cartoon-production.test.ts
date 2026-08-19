import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { Runner } from "../src/runner.ts";
import { loadGraph } from "../src/graph.ts";
import { makeCastLoaderWorker } from "../src/workers/cast.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log() {}, warn() {}, error() {} });

const CAST = {
  characters: [
    {
      character_id: "host",
      name: "Host",
      voice_id: "voice-host",
      rig: "pilot",
      personality: "skeptical and observant",
      visual_description: "Young adult cartoon host with short dark hair, warm medium skin, blue overshirt and a compact angular silhouette.",
      thumbnail_traits: "Large expressive eyes, clear eyebrow shapes and a blue overshirt that remains readable at small size.",
      color_palette: ["#4C89C6", "#F2C7A5", "#111111"]
    }
  ],
  default_voice_id: "voice-host"
};

test("default production graph is cartoon-first", async () => {
  const graph = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  assert.equal(graph.version, "11");
  assert.equal((byId.get("cast_roster") as { transformation?: string })?.transformation, "cast_loader");
  assert.equal((byId.get("script") as { transformation?: string })?.transformation, "dialogue_script_writer");
  assert.equal((byId.get("visual_plan") as { transformation?: string })?.transformation, "cartoon_visual_planner");
  assert.equal((byId.get("voice") as { transformation?: string })?.transformation, "dialogue_voice");
  assert.equal((byId.get("thumbnail_brief") as { transformation?: string })?.transformation, "cartoon_thumbnail_designer");
});

test("cartoon thumbnail brief schema requires artwork separate from compositor text", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  assert.equal(registry.resolveVersion("thumbnail_brief"), "1.2.0");

  const payload = {
    mode: "cartoon",
    text: "DON'T OPEN IT",
    emphasis: "OPEN",
    art_prompt:
      "Create a 16:9 long-form YouTube thumbnail in a clean thick-outline 2D cartoon style. Show the recurring host recoiling from a glowing locker on the right, eyes and body aimed toward the locker, with a simple school hallway behind them. Reserve the left side as quiet negative space. Strong yellow-blue value contrast. No words, letters, signs, logos, arrows, circles, captions or watermarks. No photorealism or 3D rendering.",
    accent: "#FFC712",
    visual_hook: "A frightened host recoils while an ordinary school locker glows from inside.",
    character_ids: ["host"],
    preferred_text_side: "left",
    rationale: "The face supplies the emotional first read and the unexplained locker supplies the question; the short text adds tension without revealing the answer.",
    alternatives: ["WHAT'S INSIDE?", "IT SHOULDN'T OPEN"]
  };

  assert.doesNotThrow(() => registry.validate("thumbnail_brief", "1.2.0", payload));
  assert.throws(
    () => registry.validate("thumbnail_brief", "1.2.0", { ...payload, art_prompt: "photo of locker" }),
    /thumbnail_brief@1.2.0/,
  );
});

test("visual_plan separates deterministic cartoon templates from legacy media-search scenes", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  assert.equal(registry.resolveVersion("visual_plan"), "1.3.0");

  const cartoonPlan = {
    scenes: [
      {
        scene_index: 0,
        template_category: "cartoon",
        template_data: JSON.stringify({
          background: { flat: "#24364B" },
          camera: { type: "static" },
          characters: [
            {
              characterId: "pilot",
              x: 300,
              y: 330,
              scale: 1,
              isSpeaking: true,
            },
          ],
        }),
      },
    ],
  };

  // Cartoon/template scenes must not fabricate stock-search metadata.
  assert.doesNotThrow(() => registry.validate("visual_plan", "1.3.0", cartoonPlan));

  // A declared template still needs its render props.
  assert.throws(
    () => registry.validate("visual_plan", "1.3.0", {
      scenes: [{ scene_index: 0, template_category: "cartoon" }],
    }),
    /visual_plan@1.3.0/,
  );

  // Historical non-template artifacts keep their full media-search contract.
  assert.doesNotThrow(
    () => registry.validate("visual_plan", "1.3.0", {
      scenes: [{
        scene_index: 0,
        search_terms: ["old library", "dusty shelves", "reading room"],
        fallback_terms: ["library", "books"],
        visual_style: "documentary interior",
      }],
    }),
  );
  assert.throws(
    () => registry.validate("visual_plan", "1.3.0", {
      scenes: [{ scene_index: 0 }],
    }),
    /visual_plan@1.3.0/,
  );
});

test("scheduled cast loader survives the real producer allowlist/store boundary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cartoon-cast-"));
  const file = path.join(dir, "cast.json");
  await writeFile(file, JSON.stringify(CAST), "utf8");

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "cartoon-cast-store-")),
    registry,
  );
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
  });

  const old = process.env["CARTOON_CAST_PATH"];
  process.env["CARTOON_CAST_PATH"] = file;
  try {
    const out = await runner.run(makeCastLoaderWorker(), []);
    assert.equal(out.artifact.schema_id, "cast_roster");
    assert.equal(out.artifact.schema_version, "1.1.0");
    assert.deepEqual(out.artifact.payload, CAST);
    assert.equal(out.artifact.produced_by.transformation, "cast_loader");
  } finally {
    if (old === undefined) delete process.env["CARTOON_CAST_PATH"];
    else process.env["CARTOON_CAST_PATH"] = old;
  }
});
