/**
 * Live smoke test: runs the skeleton graph against a real provider.
 *
 *   OPENAI_API_KEY=sk-... npm run smoke -- "why Chile is so incredibly long"
 *
 * The graph parks at the story approval gate unless the model reports
 * confidence >= 0.9. To approve and continue:
 *
 *   OPENAI_API_KEY=sk-... npm run smoke -- --approve <run_id>
 *
 * Each provider is real when its credential is present and a deterministic fake
 * otherwise, so a partial setup still runs end to end. See .env.example.
 *
 * Publishing needs BOTH a YouTube token AND an explicit --publish flag, and
 * always uploads as private.
 *
 * Artifacts and the run log land in ./.vidgen-data.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { JsonlRunLog, rollup } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { loadAgentDefs, validateCatalog } from "../src/catalog.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";
import { FsBlobStore } from "../src/blobs.ts";
import {
  FakeSpeechProvider,
  FakeImageProvider,
  FakeRenderer,
  FakePublishTarget,
} from "../src/providers/fake.ts";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";
import { FalImageProvider } from "../src/providers/fal.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";
import { YouTubeTarget } from "../src/providers/youtube.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { GraphExecutor, type GraphRunResult } from "../src/executor.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env["AMOS_DATA"] ?? path.join(ROOT, ".vidgen-data");

async function main() {
  if (!process.env["OPENAI_API_KEY"]?.trim()) {
    console.error("OPENAI_API_KEY is not set — nothing to smoke test against.");
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const approveAt = argv.indexOf("--approve");
  const resumeRunId = approveAt >= 0 ? argv[approveAt + 1] : null;
  const reallyPublish = argv.includes("--publish");
  const brief = argv
    .filter((a, i) => !a.startsWith("--") && i !== approveAt + 1)
    .join(" ") || "why Chile is so incredibly long";

  const env = (k: string) => {
    const v = process.env[k];
    return v && v.trim() ? v.trim() : undefined;
  };

  // Each provider is real when its credential is present, and a deterministic
  // fake otherwise — so a partial setup still runs end to end instead of
  // failing at the first missing key.
  const speech = env("ELEVENLABS_API_KEY")
    ? new ElevenLabsProvider({ apiKey: env("ELEVENLABS_API_KEY")! })
    : new FakeSpeechProvider();
  const images = env("FAL_KEY")
    ? new FalImageProvider({ apiKey: env("FAL_KEY")! })
    : new FakeImageProvider();
  const renderer = env("COMPOSE_URL")
    ? new ComposeRenderer({ baseUrl: env("COMPOSE_URL")! })
    : new FakeRenderer();

  // Publishing is irreversible and outward-facing, so it needs BOTH a token and
  // an explicit --publish. A token alone must never cause an upload.
  const canPublish = Boolean(env("YOUTUBE_ACCESS_TOKEN")) && reallyPublish;
  const target = canPublish
    ? new YouTubeTarget({ accessToken: env("YOUTUBE_ACCESS_TOKEN")! })
    : new FakePublishTarget({ id: "dry-run" });

  console.log("providers:");
  console.log(`  reasoning  openai (gpt-5.6-luna / gpt-5.6-luna)`);
  console.log(`  speech     ${speech.id}`);
  console.log(`  images     ${images.id}`);
  console.log(`  renderer   ${renderer.id}`);
  console.log(
    `  publish    ${target.id}` +
    (env("YOUTUBE_ACCESS_TOKEN") && !reallyPublish
      ? "  (token present; pass --publish to actually upload)"
      : ""),
  );
  if (canPublish) console.log("  !! will upload to YouTube as PRIVATE");
  console.log();

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const agents = (await loadAgentDefs(path.join(ROOT, "agents"))) as Map<string, TransformationDef>;
  const transformations = allTransformations(
    agents,
    defaultWorkers({
      voice: { voiceId: env("ELEVENLABS_VOICE_ID") ?? "smoke-voice" },
      // Private always: a smoke test must not publish publicly by accident.
      publish: { target, privacy: "private" },
    }),
  );
  validateCatalog(agents as never, {
    hasSchema: (id) => registry.has(id),
    hasPrompt: (ref) => prompts.has(ref),
  });

  const graph = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  validateGraph(graph, { registry, transformations }); // fails before spending anything

  const store = await FsArtifactStore.open(DATA, registry);
  const blobs = await FsBlobStore.open(DATA);
  const runLog = new JsonlRunLog(path.join(DATA, "runs.jsonl"));

  // The only place a concrete model id appears (RFC 0004). Mirrors
  // service.ts's reasoning_high mapping - keep both in sync.
  const providers = new ProviderRouter({
    reasoning_high: new OpenAIProvider({ effort: "medium" }),
    reasoning_fast: new OpenAIProvider({ effort: "medium" }),
  });

  const runner = new Runner({
    store,
    registry,
    prompts,
    providers,
    runLog,
    logger: console,
    blobs,
    media: { speech, images, renderer },
  });
  const executor = new GraphExecutor({
    runner,
    runLog,
    store,
    registry,
    transformations,
    logger: console,
  });

  let result: GraphRunResult;
  if (resumeRunId) {
    console.log(`resuming ${resumeRunId} with approval...`);
    result = await executor.resume(graph, resumeRunId, {
      approve_story: { result: "approve" },
    });
  } else {
    const intent = await store.put({
      schema_id: "intent",
      payload: { brief, target_duration_sec: 540 },
      produced_by: { transformation: "human", version: "1", run_id: "smoke", provider: null },
    });
    console.log(`intent  ${intent.artifact.artifact_id}`);
    result = await executor.start(graph, { intent: intent.artifact.artifact_id });
  }

  console.log(`\nrun ${result.run_id}  graph ${result.graph}  status ${result.status}`);
  for (const [nodeId, artifactId] of Object.entries(result.outputs)) {
    const a = await store.get(artifactId);
    const conf = a?.confidence?.overall;
    console.log(
      `  ${nodeId.padEnd(14)} ${a?.schema_id.padEnd(12)} ${artifactId.slice(0, 20)}…` +
      (conf === undefined || conf === null ? "" : `  confidence ${conf}`),
    );
  }

  for (const w of result.waiting) {
    console.log(`\n  WAITING at "${w.node_id}": ${w.reason}`);
    console.log(`  approve with:  npm run smoke -- --approve ${result.run_id}`);
  }
  for (const f of result.failures) {
    console.log(`\n  FAILED "${f.node_id}" (${f.transformation}): ${f.error}`);
  }
  if (result.blocked.length) console.log(`  blocked: ${result.blocked.join(", ")}`);

  const publishedId = result.outputs["publish"];
  if (publishedId) {
    const ep = await store.require(publishedId, { schema_id: "published_episode" });
    const p = ep.payload as { target: string; url: string; thumbnail_set: boolean };
    console.log(`
published to ${p.target}: ${p.url}  (thumbnail_set=${p.thumbnail_set})`);
  }

  const scriptId = result.outputs["script"];
  if (scriptId) {
    const script = await store.require(scriptId, { schema_id: "script" });
    const scenes = (script.payload as { scenes: Array<{ narration: string }> }).scenes;
    const words = scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0);
    console.log(`\nscript: ${scenes.length} scenes, ~${words} words. First three:`);
    for (const s of scenes.slice(0, 3)) console.log(`  - ${s.narration}`);
  }

  const summary = rollup((await runLog.all()).filter((r) => r.run_id === result.run_id));
  console.log(
    `\ncost $${summary.cost_usd.toFixed(4)}  in ${summary.input_tokens} / out ${summary.output_tokens} tokens`,
  );
  console.table(summary.by_transformation);
  console.log(`artifacts in ${DATA}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
