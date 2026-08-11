/**
 * Live smoke test: intent -> story -> script, against a real provider.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run smoke -- "why Chile is so incredibly long"
 *
 * Writes artifacts to ./.amos-data and prints the run log. This is the first
 * real exercise of the reasoning path; everything else in the test suite runs
 * against the fake provider.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { JsonlRunLog, rollup } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { Runner } from "../src/runner.ts";
import { loadAgentDefs, validateCatalog } from "../src/catalog.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env["AMOS_DATA"] ?? path.join(ROOT, ".amos-data");

async function main() {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error("ANTHROPIC_API_KEY is not set — nothing to smoke test against.");
    process.exit(2);
  }
  const brief = process.argv.slice(2).join(" ") || "why Chile is so incredibly long";

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  validateCatalog(agents, {
    hasSchema: (id) => registry.has(id),
    hasPrompt: (ref) => prompts.has(ref),
  });

  const store = await FsArtifactStore.open(DATA, registry);
  const runLog = new JsonlRunLog(path.join(DATA, "runs.jsonl"));

  // Capability -> concrete model. The only place a model id appears.
  const providers = new ProviderRouter({
    reasoning_high: new AnthropicProvider({ model: "claude-opus-5", effort: "high" }),
    reasoning_fast: new AnthropicProvider({ model: "claude-sonnet-5", effort: "medium" }),
  });

  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: console });

  const intent = await store.put({
    schema_id: "intent",
    payload: { brief, target_duration_sec: 540 },
    produced_by: { transformation: "human", version: "1", run_id: "smoke", provider: null },
  });
  console.log(`intent  ${intent.artifact.artifact_id}`);

  const story = await runner.run(agents.get("story_architect")!, [intent.artifact.artifact_id]);
  const s = story.artifact.payload as { title: string; acts: unknown[] };
  console.log(
    `story   ${story.artifact.artifact_id}  "${s.title}"  ` +
      `${s.acts.length} acts  confidence ${story.artifact.confidence?.overall}  ` +
      `(${story.attempts} attempt(s))`,
  );

  const script = await runner.run(agents.get("script_writer")!, [story.artifact.artifact_id]);
  const sc = script.artifact.payload as { scenes: Array<{ narration: string }> };
  const words = sc.scenes.reduce((n, x) => n + x.narration.split(/\s+/).length, 0);
  console.log(
    `script  ${script.artifact.artifact_id}  ${sc.scenes.length} scenes  ~${words} words  ` +
      `confidence ${script.artifact.confidence?.overall}  (${script.attempts} attempt(s))`,
  );

  console.log("\nfirst three scenes:");
  for (const scene of sc.scenes.slice(0, 3)) console.log(`  - ${scene.narration}`);

  const summary = rollup(await runLog.all());
  console.log(
    `\ncost $${summary.cost_usd.toFixed(4)}  ` +
      `in ${summary.input_tokens} / out ${summary.output_tokens} tokens`,
  );
  console.table(summary.by_transformation);
  console.log(`\nartifacts in ${DATA}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
