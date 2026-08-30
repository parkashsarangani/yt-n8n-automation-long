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
import { ProviderRouter, relaxForStructuredOutput, wrapWithConfidence, type CompletionRequest } from "../src/provider.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { GraphExecutor } from "../src/executor.ts";
import { makeCastLoaderWorker } from "../src/workers/cast.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";
import { FakeProvider, FakeSpeechProvider, FakeImageProvider, FakeRenderer, FakePublishTarget } from "../src/providers/fake.ts";

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

function countOptionalObjectProperties(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countOptionalObjectProperties(item), 0);
  if (value === null || typeof value !== "object") return 0;
  const node = value as Record<string, unknown>;
  let total = 0;
  if (node.type === "object" && node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? node.required.filter((v): v is string => typeof v === "string") : []);
    total += Object.keys(node.properties as Record<string, unknown>).filter((key) => !required.has(key)).length;
  }
  for (const nested of Object.values(node)) total += countOptionalObjectProperties(nested);
  return total;
}

test("default production graph is cartoon-first", async () => {
  const graph = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  assert.equal(graph.version, "16");
  assert.equal((byId.get("cast_roster") as { transformation?: string })?.transformation, "cast_loader");
  assert.equal((byId.get("script") as { transformation?: string })?.transformation, "dialogue_script_writer");
  assert.equal((byId.get("visual_plan") as { transformation?: string })?.transformation, "explanation_visual_planner");
  assert.equal((byId.get("voice") as { transformation?: string })?.transformation, "dialogue_voice");
  assert.equal((byId.get("thumbnail_brief") as { transformation?: string })?.transformation, "cartoon_thumbnail_designer");
  assert.equal((byId.get("render") as { transformation?: string })?.transformation, "cartoon_render");
  assert.equal((byId.get("plan_review") as { transformation?: string })?.transformation, "explanation_plan_critic");
  assert.equal((byId.get("plan_revision") as { transformation?: string })?.transformation, "explanation_plan_reviser");
  assert.equal((byId.get("plan_release") as { transformation?: string })?.transformation, "explanation_plan_release");

  // The default production path must exercise the entire semantic/hybrid chain.
  // A review wired only into cartoon.json, or a renderer still consuming the
  // compiler output directly, would make the semantic architecture advisory.
  assert.deepEqual((byId.get("assets") as { in?: string[] })?.in, ["plan_release", "approve_script", "cast_roster"]);
  assert.equal((byId.get("semantic_assets") as { transformation?: string })?.transformation, "semantic_visual_assets");
  assert.deepEqual((byId.get("semantic_assets") as { in?: string[] })?.in, ["assets", "plan_release", "approve_script", "voice"]);
  assert.equal((byId.get("hybrid_assets") as { transformation?: string })?.transformation, "hybrid_visual_assets");
  assert.deepEqual((byId.get("hybrid_assets") as { in?: string[] })?.in, ["semantic_assets", "plan_release", "approve_script", "cast_roster", "voice"]);
  assert.ok((byId.get("render") as { in?: string[] })?.in?.includes("hybrid_assets"));
  assert.ok((byId.get("qa") as { in?: string[] })?.in?.includes("hybrid_assets"));
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

  assert.doesNotThrow(() => registry.validate("visual_plan", "1.3.0", cartoonPlan));
  assert.throws(
    () => registry.validate("visual_plan", "1.3.0", {
      scenes: [{ scene_index: 0, template_category: "cartoon" }],
    }),
    /visual_plan@1.3.0/,
  );
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

test("cartoon visual-plan schema keeps Anthropic structured output low-complexity", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const schema = registry.jsonSchema("visual_plan", "1.6.0") as Record<string, unknown>;
  const wrapped = wrapWithConfidence(schema, ["concreteness", "variety"]);
  const projected = relaxForStructuredOutput(wrapped);

  assert.ok(
    countOptionalObjectProperties(projected) <= 4,
    `cartoon planner structured-output schema has too many optional object properties: ${countOptionalObjectProperties(projected)}`,
  );

  const scenes = (schema.properties as Record<string, unknown>).scenes as Record<string, unknown>;
  const scene = scenes.items as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(scene.required?.length, 14);
  for (const legacy of ["template_data", "search_terms", "fallback_terms", "visual_style"]) {
    assert.equal(legacy in (scene.properties ?? {}), false, `${legacy} must stay out of the model-facing cartoon schema`);
  }
  assert.equal("house_style" in (schema.properties as Record<string, unknown>), false);
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
    assert.equal(out.artifact.schema_version, "1.2.0");
    assert.deepEqual(out.artifact.payload, CAST);
    assert.equal(out.artifact.produced_by.transformation, "cast_loader");
  } finally {
    if (old === undefined) delete process.env["CARTOON_CAST_PATH"];
    else process.env["CARTOON_CAST_PATH"] = old;
  }
});

test("the shipped production graph runs unattended end to end with fake providers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cartoon-e2e-cast-"));
  const castFile = path.join(dir, "cast.json");
  await writeFile(castFile, JSON.stringify(CAST), "utf8");

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "cartoon-e2e-store-")), registry);
  const runLog = new MemoryRunLog();
  const agents = (await loadAgentDefs(path.join(ROOT, "agents"))) as Map<string, TransformationDef>;

  const STORY = {
    topic: "Why the school locker room hums at night",
    title: "The Locker That Hums",
    hook: "Every school has one locker nobody opens twice.",
    acts: [
      { act_index: 0, act_title: "The rumor", premise: "Host hears about the humming locker.", target_words: 60 },
      { act_index: 1, act_title: "The dare", premise: "Buddy dares Host to open it.", target_words: 60 },
      { act_index: 2, act_title: "The hum", premise: "They open it together.", target_words: 60 },
    ],
    payoff: "Some things hum because they are waiting.",
    comment_hook: "Would you have opened it?",
    outro_line: "Tell us what's humming in your school.",
  };
  const SCRIPT = {
    scenes: [
      {
        scene_index: 0,
        act_index: 0,
        point: "action=Host stops beside a humming locker; prop=locker; function=opening_problem; value=the mystery is visible immediately",
        narration: "That locker is humming.",
        speaker: "host",
        emotion: "neutral",
      },
      {
        scene_index: 1,
        act_index: 1,
        point: "action=Host reaches for the locker handle but pulls back; prop=locker; function=failed_attempt midpoint_turn; value=the dare becomes a visible choice",
        narration: "I hate that it sounds patient.",
        speaker: "host",
        emotion: "scared",
      },
      {
        scene_index: 2,
        act_index: 2,
        point: "action=Host opens the locker and the hum gets louder; prop=locker; function=payoff_resolution practical_action; value=return to the object and answer the opening mystery",
        narration: "Fine. It was waiting.",
        speaker: "host",
        emotion: "surprised",
      },
    ],
    word_count: 17,
  };
  const CREATIVE_DIRECTION = {
    character_roles: [
      {
        character_id: "host",
        comic_role: "curious narrator who fears the locker but opens it anyway",
        voice_markers: ["That locker", "I hate", "Fine"],
        reaction_pattern: "freezes beside the locker, names the dread, then acts despite it",
      },
    ],
    callback: {
      seed: "the locker is humming",
      escalation: "the hum sounds patient",
      payoff: "the hum was waiting",
    },
    scenes: SCRIPT.scenes.map((scene) => ({
      scene_index: scene.scene_index,
      scene_function: scene.scene_index === 0 ? "opening_problem" : scene.scene_index === 1 ? "failed_attempt" : "payoff_resolution",
      energy_beat: scene.scene_index === 0 ? "hook" : scene.scene_index === 1 ? "dread escalation" : "callback payoff",
      foreground_prop: {
        type: "locker",
        state: scene.scene_index === 0 ? "humming" : scene.scene_index === 1 ? "handle-waiting" : "open-humming",
        motion: scene.scene_index === 1 ? "tremble" : scene.scene_index === 2 ? "open" : "pulse",
        anchor: "background",
        action: scene.scene_index === 0
          ? "Locker hums before Host touches it"
          : scene.scene_index === 1
            ? "Locker handle waits while Host pulls back"
            : "Locker opens and answers the setup",
      },
      blocking: {
        speaker_position: "left",
        listener_position: "unchanged",
        prop_position: "background",
        power_shift: scene.scene_index === 0
          ? "the locker owns the room"
          : scene.scene_index === 1
            ? "the dare pushes Host toward the handle"
            : "Host chooses to open the object",
      },
      metaphor: {
        type: scene.scene_index === 2 ? "callback-card" : scene.scene_index === 1 ? "reaction-pop" : "none",
        label: scene.scene_index === 2 ? "THE HUM ANSWERS" : scene.scene_index === 1 ? "PATIENT" : "",
        emotional_beat: scene.scene_index === 0 ? "uneasy curiosity" : scene.scene_index === 1 ? "dread becomes visible" : "the mystery answers back",
      },
      callback_role: scene.scene_index === 0 ? "seed" : scene.scene_index === 1 ? "escalation" : "payoff",
      performance_note: scene.scene_index === 0
        ? "Host notices the sound before explaining it"
        : scene.scene_index === 1
          ? "Host should look annoyed that the hum feels patient"
          : "Let the final line land as reluctant acceptance",
    })),
  };

  const characterPerformance = (emotion: "neutral" | "scared" | "surprised") => ({
    listener_actor_id: "host",
    speaker_emotion: emotion,
    speaker_gesture: emotion === "neutral" ? "idle" : "explain",
    speaker_gaze_target: "auto",
    listener_emotion: "neutral",
    listener_gesture: "idle",
    listener_gaze_target: "auto",
  });

  const VISUAL_PLAN = {
    scenes: [
      {
        scene_index: 0,
        template_category: "explanation",
        scene_role: "character-hook",
        visual_operation: "timeline",
        visual_primitive: "cause-chain",
        visual_state: "hypothesis",
        composition_mode: "bookend",
        explanation_title: "The mystery",
        model_elements: ["humming locker", "Host notices"],
        model_relations: [{ from_element: 0, to_element: 1, kind: "causes" }],
        numeric_value: null,
        state_before: "",
        state_after: "",
        key_text: "Why is it humming?",
        character_cut_in: "both",
        sound_cue: "none",
        representation_mode: "kinetic-text",
        scene_blueprint: "animated-statement",
        visual_claim: "The locker is already humming before Host touches it.",
        visual_actions: [],
        ...characterPerformance("neutral"),
      },
      {
        scene_index: 1,
        template_category: "explanation",
        scene_role: "character-reaction",
        visual_operation: "compress",
        visual_primitive: "physical-transformation",
        visual_state: "mechanism",
        composition_mode: "full-model",
        explanation_title: "The choice",
        model_elements: ["Host", "locker handle"],
        model_relations: [{ from_element: 0, to_element: 1, kind: "feeds" }],
        numeric_value: null,
        state_before: "reaching",
        state_after: "pulls back",
        key_text: "It sounds patient",
        character_cut_in: "none",
        sound_cue: "soft-hit",
        representation_mode: "kinetic-text",
        scene_blueprint: "animated-statement",
        visual_claim: "Host hesitates because the hum feels unnervingly patient.",
        visual_actions: [],
      },
      {
        scene_index: 2,
        template_category: "explanation",
        scene_role: "recap",
        visual_operation: "payoff",
        visual_primitive: "before-after",
        visual_state: "payoff",
        composition_mode: "bookend",
        explanation_title: "The answer",
        model_elements: ["closed locker", "open locker"],
        model_relations: [{ from_element: 0, to_element: 1, kind: "becomes" }],
        numeric_value: null,
        state_before: "closed and humming",
        state_after: "open and louder",
        key_text: "It was waiting",
        character_cut_in: "both",
        sound_cue: "resolve",
        representation_mode: "kinetic-text",
        scene_blueprint: "animated-statement",
        visual_claim: "Opening the locker resolves the setup instead of merely restating it.",
        visual_actions: [],
        ...characterPerformance("surprised"),
      },
    ],
  };

  const SEO = {
    title: "The Locker That Hums Every Night",
    description: "A".repeat(60),
    tags: ["school", "mystery", "locker", "cartoon", "short story"],
    primary_keyword: "humming locker",
    rationale: "The unresolved sound is the hook; the title promises the same mystery the video opens with.",
  };
  const THUMBNAIL_BRIEF = {
    mode: "cartoon",
    text: "IT HUMS",
    emphasis: "HUMS",
    art_prompt:
      "Create a 16:9 long-form YouTube thumbnail in a clean thick-outline 2D cartoon style. Show the recurring " +
      "host staring at a glowing locker in a school hallway, wide-eyed. Reserve the left side as quiet negative " +
      "space. No words, letters, signs, logos, arrows, circles, captions or watermarks. No photorealism or 3D rendering.",
    accent: "#FFC712",
    visual_hook: "The host stares at a locker humming with light.",
    character_ids: ["host"],
    preferred_text_side: "left",
    rationale: "The face carries the reaction; the glow supplies the unanswered question.",
  };
  const PLAN_REVIEW = {
    overall_verdict: "revise",
    episode_note: "The payoff should visibly transform the locker rather than remain a statement card.",
    scenes: [0, 1, 2].map((i) => (i === 2
      ? {
        scene_index: i,
        verdict: "weak",
        failure_mode: "wrong-representation",
        note: "The payoff is concrete and state-changing, but the plan uses kinetic text.",
        suggested_fix: "Use concrete-scene + before-after-object and transform the closed locker into the open locker on the payoff phrase.",
      }
      : { scene_index: i, verdict: "adequate", failure_mode: "none", note: "", suggested_fix: "" })),
  };
  const REVISED_VISUAL_PLAN = {
    scenes: VISUAL_PLAN.scenes.map((scene) => (scene.scene_index === 2
      ? {
        ...scene,
        representation_mode: "concrete-scene",
        scene_blueprint: "before-after-object",
        visual_claim: "The closed humming locker becomes visibly open as the answer lands.",
        visual_actions: [{ actor: "locker", action: "transform", target: "open locker", anchor_phrase: "It was waiting" }],
      }
      : scene)),
  };
  const INSIGHTS = { sample_size: 0, confidence_note: "Nothing measured yet; no guidance can be supported.", guidance: [] };

  const provider = new FakeProvider((req: CompletionRequest) => {
    const schema = req.outputSchema as { properties?: { payload?: { title?: string } } };
    const title = schema.properties?.payload?.title ?? "";
    if (title.includes("ChannelInsights")) return { payload: INSIGHTS, confidence: { overall: 0.9 } };
    if (title.includes("Story")) return { payload: STORY, confidence: { overall: 0.9 } };
    if (title.includes("Script")) return { payload: SCRIPT, confidence: { overall: 0.9 } };
    if (title.includes("CartoonCreativeDirection")) return { payload: CREATIVE_DIRECTION, confidence: { overall: 0.9 } };
    if (title.includes("ExplanationPlanReview")) return { payload: PLAN_REVIEW, confidence: { overall: 0.9 } };
    if (title.includes("SemanticVisualPlan")) {
      const revising = req.prompt.includes("Storyboard review:");
      return { payload: revising ? REVISED_VISUAL_PLAN : VISUAL_PLAN, confidence: { overall: 0.9 } };
    }
    if (title.includes("Seo")) return { payload: SEO, confidence: { overall: 0.9 } };
    if (title.includes("ThumbnailBrief")) return { payload: THUMBNAIL_BRIEF, confidence: { overall: 0.9 } };
    throw new Error(`no fake response configured for output schema "${title}"`);
  });
  const providers = new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider });

  const media = {
    speech: new FakeSpeechProvider(),
    images: new FakeImageProvider(),
    renderer: new FakeRenderer(),
  };

  const workers = defaultWorkers({
    voice: { voiceId: "fallback-voice" },
    publish: { target: new FakePublishTarget(), privacy: "private" },
  });
  const transformations = allTransformations(agents, workers);

  const graph = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  validateGraph(graph, { registry, transformations });

  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: silent(), blobs: new MemoryBlobStore(), media });
  const executor = new GraphExecutor({ runner, runLog, store, registry, transformations, logger: silent() });

  const old = process.env["CARTOON_CAST_PATH"];
  process.env["CARTOON_CAST_PATH"] = castFile;
  try {
    const intent = await store.put({
      schema_id: "intent",
      payload: { brief: "why the school locker room hums at night", target_duration_sec: 60 },
      produced_by: { transformation: "human", version: "1", run_id: "e2e", provider: null },
    });
    const performance = await store.put({
      schema_id: "performance_window",
      payload: { generated_at: new Date().toISOString(), episode_count: 0, episodes: [] },
      produced_by: { transformation: "human", version: "1", run_id: "e2e", provider: null },
    });

    const result = await executor.start(graph, {
      intent: intent.artifact.artifact_id,
      performance: performance.artifact.artifact_id,
    });

    assert.deepEqual(result.failures, [], `unexpected node failures: ${JSON.stringify(result.failures)}`);
    assert.deepEqual(
      result.waiting.map((w) => w.node_id).filter((id) => id === "approve_story" || id === "approve_script"),
      [],
    );
    for (const nodeId of ["story", "script", "visual_plan", "plan_review", "plan_revision", "plan_release", "assets", "voice", "semantic_assets", "hybrid_assets", "seo", "thumbnail_brief", "thumbnail", "render", "qa"]) {
      assert.ok(result.outputs[nodeId], `node "${nodeId}" produced no output`);
    }
    assert.notEqual(result.status, "blocked");
  } finally {
    if (old === undefined) delete process.env["CARTOON_CAST_PATH"];
    else process.env["CARTOON_CAST_PATH"] = old;
  }
});
