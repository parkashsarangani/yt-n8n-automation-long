/**
 * Live smoke test: runs the skeleton graph against a real provider.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run smoke -- "why Chile is so incredibly long"
 *
 * The graph parks at the story approval gate unless the model reports
 * confidence >= 0.9. To approve and continue:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run smoke -- --approve <run_id>
 *
 * Artifacts and the run log land in ./.amos-data.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { JsonlRunLog, rollup } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { loadAgentDefs, validateCatalog } from "../src/catalog.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { GraphExecutor, type GraphRunResult } from "../src/executor.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env["AMOS_DATA"] ?? path.join(ROOT, ".amos-data");

async function main() {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error("ANTHROPIC_API_KEY is not set — nothing to smoke test against.");
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const approveAt = argv.indexOf("--approve");
  const resumeRunId = approveAt >= 0 ? argv[approveAt + 1] : null;
  const brief = (approveAt >= 0 ? [] : argv).join(" ") || "why Chile is so incredibly long";

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const transformations = (await loadAgentDefs(path.join(ROOT, "agents"))) as Map<
    string,
    TransformationDef
  >;
  validateCatalog(transformations as never, {
    hasSchema: (id) => registry.has(id),
    hasPrompt: (ref) => prompts.has(ref),
  });

  const graph = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  validateGraph(graph, { registry, transformations }); // fails before spending anything

  const store = await FsArtifactStore.open(DATA, registry);
  const runLog = new JsonlRunLog(path.join(DATA, "runs.jsonl"));

  // The only place a concrete model id appears (RFC 0004).
  const providers = new ProviderRouter({
    reasoning_high: new AnthropicProvider({ model: "claude-opus-5", effort: "high" }),
    reasoning_fast: new AnthropicProvider({ model: "claude-sonnet-5", effort: "medium" }),
  });

  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: console });
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
