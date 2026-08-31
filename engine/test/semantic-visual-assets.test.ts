import test from "node:test";
import assert from "node:assert/strict";

import {
  blueprintFitsMode,
  normaliseWithMap,
  resolveActionWindows,
  semanticPayload,
  makeSemanticVisualAssetsWorker,
  type SemanticAction,
} from "../src/workers/semantic-visual-assets.ts";
import { bridgeSemanticTemplateData } from "../src/providers/compose.ts";
import type { Artifact } from "../src/artifact.ts";
import type { WorkerContext } from "../src/runner.ts";

function fakeCtx(): WorkerContext {
  return {
    attemptNumber: 1,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    blobs: {
      get: async () => new Uint8Array(),
      put: async () => "blob://unused",
      has: async () => false,
    } as unknown as WorkerContext["blobs"],
    media: {},
    progress: async () => {},
  };
}

test("semantic representation mode only accepts its supported renderer family", () => {
  assert.equal(blueprintFitsMode("concrete-scene", "container-object"), true);
  assert.equal(blueprintFitsMode("concrete-scene", "before-after-object"), true);
  assert.equal(blueprintFitsMode("domain-model", "molecular-system"), true);
  assert.equal(blueprintFitsMode("domain-model", "lattice"), true);
  assert.equal(blueprintFitsMode("domain-model", "particle-system"), true);
  assert.equal(blueprintFitsMode("domain-model", "flow-system"), true);
  assert.equal(blueprintFitsMode("quantitative", "mass-volume-comparison"), true);
  assert.equal(blueprintFitsMode("spatial", "cross-section"), true);
  assert.equal(blueprintFitsMode("spatial", "map"), true);
  assert.equal(blueprintFitsMode("temporal", "timeline"), true);
  assert.equal(blueprintFitsMode("kinetic-text", "animated-statement"), true);
  assert.equal(blueprintFitsMode("domain-model", "before-after-object"), false);
  assert.equal(blueprintFitsMode("quantitative", "lattice"), false);
});

test("phrase normalization keeps source offsets while ignoring case and punctuation", () => {
  const normalized = normaliseWithMap("Fine.  IT was—waiting!");
  assert.equal(normalized.text, "fine it was waiting");
  assert.equal(normalized.sourceIndex.length, normalized.text.length);
  assert.equal("Fine.  IT was—waiting!"[normalized.sourceIndex[0]!], "F");
  assert.equal("Fine.  IT was—waiting!"[normalized.sourceIndex.at(-1)!], "g");
});

test("semantic actions align to the spoken phrase instead of a scene-level clock", () => {
  const narration = "Fine. It was waiting.";
  const characters = [...narration];
  const alignment = {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.08),
    character_end_times_seconds: characters.map((_, i) => i * 0.08 + 0.07),
  };
  const actions: SemanticAction[] = [
    { actor: "locker", action: "transform", target: "open locker", anchor_phrase: "IT WAS WAITING" },
  ];

  const [window] = resolveActionWindows(actions, narration, alignment, 2);
  assert.ok(window);
  assert.equal(window!.aligned, true);
  assert.ok(window!.startRatio > 0.1, `unexpected start ${window!.startRatio}`);
  assert.ok(window!.endRatio > window!.startRatio);
  assert.ok(window!.endRatio <= 0.96);
});

test("missing or mismatched alignment falls back deterministically and preserves action order", () => {
  const actions: SemanticAction[] = [
    { actor: "water", action: "cool", target: "water", anchor_phrase: "not in narration" },
    { actor: "ice", action: "rise", target: "surface", anchor_phrase: "also absent" },
    { actor: "ice", action: "settle", target: "surface", anchor_phrase: "still absent" },
  ];

  const windows = resolveActionWindows(actions, "A different spoken sentence.", null, 4);
  assert.equal(windows.length, 3);
  assert.ok(windows.every((window) => window.aligned === false));
  assert.ok(windows[0]!.startRatio < windows[1]!.startRatio);
  assert.ok(windows[1]!.startRatio < windows[2]!.startRatio);
  assert.ok(windows.every((window) => window.endRatio > window.startRatio));
});

test("unsupported or incomplete semantic intent fails closed to animated explanatory text", () => {
  const base = {
    keyText: "Density changes",
    rendererPerformance: { meaningfulStateChange: false },
  };
  const payload = semanticPayload(base, {
    scene_index: 0,
    representation_mode: "domain-model",
    // Deliberately mismatched: before-after-object is not a domain-model family.
    scene_blueprint: "before-after-object",
    visual_claim: "Water molecules form an open lattice.",
    visual_actions: [],
  }, []);

  assert.equal(payload["representationMode"], "kinetic-text");
  assert.equal(payload["sceneBlueprint"], "animated-statement");
  assert.equal(payload["semanticFallback"], true);
  assert.deepEqual(payload["semanticActionWindows"], []);
});

test("supported concrete intent keeps its causal action windows", () => {
  const windows = [{
    actor: "ice cube",
    action: "rise",
    target: "surface",
    startRatio: 0.34,
    endRatio: 0.56,
    aligned: true,
  }];
  const payload = semanticPayload({}, {
    scene_index: 0,
    representation_mode: "concrete-scene",
    scene_blueprint: "container-object",
    visual_claim: "The ice cube rises until part of it sits above the waterline.",
    visual_actions: [{ actor: "ice cube", action: "rise", target: "surface", anchor_phrase: "rises" }],
  }, windows);

  assert.equal(payload["representationMode"], "concrete-scene");
  assert.equal(payload["sceneBlueprint"], "container-object");
  assert.equal(payload["semanticFallback"], false);
  assert.deepEqual(payload["semanticActionWindows"], windows);
});

test("semantic payload carries stable ontology ids and depiction metadata", () => {
  const entities = [{ entity_id: "ice-cube", label: "ice cube", aliases: ["ice"], depiction: { kind: "solid-object", appearance: "translucent cube", color: "#65C7F7" } }];
  const payload = semanticPayload({}, {
    scene_index: 0, representation_mode: "concrete-scene", scene_blueprint: "container-object",
    visual_claim: "The ice cube rises.", entity_refs: ["ice-cube"],
    visual_actions: [{ actor: "ice-cube", action: "rise", target: "surface", anchor_phrase: "rises" }],
  }, [{ actor: "ice-cube", action: "rise", target: "surface", startRatio: .2, endRatio: .6, aligned: true }], entities);
  assert.deepEqual(payload["entityIdentityKeys"], ["ice-cube"]);
  assert.deepEqual(payload["semanticEntities"], entities);
});

test("long-compose bridge carries semantic metadata through the existing explanation whitelist", () => {
  const originalIcon = { viewBox: "0 0 24 24", body: "<path />" };
  const bridged = bridgeSemanticTemplateData({
    entityIcons: { "entity-ice": originalIcon },
    representationMode: "concrete-scene",
    sceneBlueprint: "container-object",
    visualClaim: "Ice rises to the surface.",
    semanticActionWindows: [{ actor: "ice", action: "rise", target: "surface", startRatio: 0.2, endRatio: 0.5, aligned: true }],
    semanticEntities: [],
    semanticFallback: false,
  });

  assert.ok(bridged);
  const icons = bridged!["entityIcons"] as Record<string, unknown>;
  assert.deepEqual(icons["entity-ice"], originalIcon);
  assert.equal(icons["__semanticRepresentationV1"], undefined);
  assert.deepEqual(bridged!["semanticRepresentation"], {
    representationMode: "concrete-scene",
    sceneBlueprint: "container-object",
    visualClaim: "Ice rises to the surface.",
    semanticActionWindows: [{ actor: "ice", action: "rise", target: "surface", startRatio: 0.2, endRatio: 0.5, aligned: true }],
    semanticEntities: [],
    semanticFallback: false,
  });
});

test("non-semantic explanation data is not altered by the renderer bridge", () => {
  const legacy = { keyText: "legacy", entityIcons: {} };
  assert.equal(bridgeSemanticTemplateData(legacy), legacy);
});

test("semantic worker preserves resumed legacy diagram template data", async () => {
  const worker = makeSemanticVisualAssetsWorker();
  const legacyTemplate = JSON.stringify({
    keyText: "legacy diagram",
    visualPrimitive: "network",
    modelRelations: [{ from_element: 0, to_element: 1, kind: "causes" }],
  });
  const out = await worker.execute({
    compiled: { payload: { scenes: [{ scene_index: 0, template_category: "explanation", template_data: legacyTemplate }] } } as unknown as Artifact,
    plan: { payload: { scenes: [{ scene_index: 0, visual_primitive: "network", model_elements: ["a", "b"], model_relations: [{ from_element: 0, to_element: 1, kind: "causes" }] }] } } as unknown as Artifact,
    script: { payload: { scenes: [{ scene_index: 0, narration: "A causes B." }] } } as unknown as Artifact,
    voice: { payload: { clips: [] } } as unknown as Artifact,
    visual_model: { payload: { entities: [] } } as unknown as Artifact,
  }, fakeCtx());

  const scenes = (out.payload as { scenes: Array<{ template_data?: string }> }).scenes;
  assert.equal(scenes[0]!.template_data, legacyTemplate);
});

test("semantic worker compacts oversized semantic metadata instead of throwing", async () => {
  const worker = makeSemanticVisualAssetsWorker();
  const hugeTemplate = JSON.stringify({
    keyText: "compact me",
    padding: "x".repeat(9000),
  });
  const out = await worker.execute({
    compiled: { payload: { scenes: [{ scene_index: 0, template_category: "explanation", template_data: hugeTemplate }] } } as unknown as Artifact,
    plan: { payload: { scenes: [{
      scene_index: 0,
      representation_mode: "concrete-scene",
      scene_blueprint: "container-object",
      visual_claim: "The object rises.",
      visual_actions: [{ actor: "object", action: "rise", target: "surface", anchor_phrase: "rises" }],
    }] } } as unknown as Artifact,
    script: { payload: { scenes: [{ scene_index: 0, narration: "The object rises." }] } } as unknown as Artifact,
    voice: { payload: { clips: [{ scene_index: 0, duration_sec: 2 }] } } as unknown as Artifact,
    visual_model: { payload: { entities: [] } } as unknown as Artifact,
  }, fakeCtx());

  const [scene] = (out.payload as { scenes: Array<{ template_data?: string }> }).scenes;
  assert.ok(scene!.template_data);
  assert.ok(scene!.template_data!.length < 8000);
  const payload = JSON.parse(scene!.template_data!);
  assert.equal(payload.representationMode, "kinetic-text");
  assert.equal(payload.sceneBlueprint, "animated-statement");
  assert.equal(payload.semanticFallback, true);
  // retention_qa's visual_assets_renderable check reads degraded_count to
  // warn on episodes with too much fallback content. A scene compacted down
  // to bare kinetic-text lost its intended concrete representation just as
  // surely as a placeholder image did -- QA must be able to see that.
  assert.equal((out.payload as { degraded_count: number }).degraded_count, 1);
});

test("semantic worker counts a scene forced to kinetic-text by an unsupported combo as degraded", async () => {
  const worker = makeSemanticVisualAssetsWorker();
  const out = await worker.execute({
    compiled: { payload: { scenes: [{ scene_index: 0, template_category: "explanation", template_data: "{}" }], degraded_count: 2 } } as unknown as Artifact,
    plan: { payload: { scenes: [{
      // No renderer component exists for this combo, so semanticPayload's
      // own fail-closed path forces kinetic-text/animated-statement --
      // the size limit is never involved here, only the mode/blueprint
      // mismatch itself.
      scene_index: 0,
      representation_mode: "domain-model",
      scene_blueprint: "before-after-object",
      visual_claim: "The object rises.",
      visual_actions: [],
    }] } } as unknown as Artifact,
    script: { payload: { scenes: [{ scene_index: 0, narration: "The object rises." }] } } as unknown as Artifact,
    voice: { payload: { clips: [{ scene_index: 0, duration_sec: 2 }] } } as unknown as Artifact,
    visual_model: { payload: { entities: [] } } as unknown as Artifact,
  }, fakeCtx());

  const [scene] = (out.payload as { scenes: Array<{ template_data?: string }> }).scenes;
  const payload = JSON.parse(scene!.template_data!);
  assert.equal(payload.representationMode, "kinetic-text");
  // The upstream compiler's own degraded_count (2, from a placeholder image
  // elsewhere in the episode) must be preserved and added to, not replaced --
  // this worker runs downstream of asset compilation and both counts are
  // real degradations the same QA check reads.
  assert.equal((out.payload as { degraded_count: number }).degraded_count, 3);
});
