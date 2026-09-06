/**
 * RFC 0010 benchmark runner.
 *
 * Reuses THREE artifacts from an existing completed production episode:
 *   script, voice, rendered_video (the production/control render)
 *
 * Example:
 *   npm run visual:benchmark -- <script-artifact-id> <voice-artifact-id> <control-render-artifact-id>
 *
 * It never publishes and never mutates/replaces the production graph. The
 * benchmark produces an isolated V2 render plus visual_benchmark_report.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { JsonlRunLog, rollup } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { FalImageProvider } from "../src/providers/fal.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { loadAgentDefs, validateCatalog } from "../src/catalog.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";
import { FsBlobStore } from "../src/blobs.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { GraphExecutor } from "../src/executor.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env["AMOS_DATA"] ?? path.join(ROOT, ".vidgen-data");

function env(name:string):string|undefined { const value=process.env[name]; return value?.trim()?value.trim():undefined; }

async function main():Promise<void>{
  const [scriptId,voiceId,controlId]=process.argv.slice(2);
  if(!scriptId||!voiceId||!controlId){
    console.error("usage: npm run visual:benchmark -- <script-artifact-id> <voice-artifact-id> <control-render-artifact-id>");
    process.exit(2);
  }
  // Narration is deliberately NOT a live capability here: the benchmark must
  // reuse the supplied immutable voice artifact and its measured alignment.
  // Requiring or constructing a speech provider would make the benchmark
  // depend on a service it is explicitly forbidden to call.
  for(const required of ["FAL_KEY","PEXELS_API_KEY"]){
    if(!env(required)) throw new Error(`${required} is required for the RFC 0010 benchmark`);
  }
  if(!env("COMPOSE_URL")) throw new Error("COMPOSE_URL is required: benchmark must render actual pixels, not a fake renderer");
  if(!env("FREELLMAPI_API_KEY")&&!env("OPENAI_API_KEY")) throw new Error("A configured reasoning/VLM route is required");

  const registry=await SchemaRegistry.load(path.join(ROOT,"schemas"));
  const prompts=await PromptStore.load(path.join(ROOT,"prompts"));
  const agents=(await loadAgentDefs(path.join(ROOT,"agents"))) as Map<string,TransformationDef>;
  validateCatalog(agents as never,{hasSchema:(id)=>registry.has(id),hasPrompt:(ref)=>prompts.has(ref)});
  const graph=await loadGraph(path.join(ROOT,"graphs","visual_benchmark.json"));

  const store=await FsArtifactStore.open(DATA,registry);
  const blobs=await FsBlobStore.open(DATA);
  const runLog=new JsonlRunLog(path.join(DATA,"runs.jsonl"));
  await store.require(scriptId,{schema_id:"script"});
  await store.require(voiceId,{schema_id:"voice"});
  await store.require(controlId,{schema_id:"rendered_video"});

  const images=new FalImageProvider({apiKey:env("FAL_KEY")!});
  const renderer=new ComposeRenderer({baseUrl:env("COMPOSE_URL")!});
  const transformations=allTransformations(agents,defaultWorkers({voice:{voiceId:"benchmark-existing-voice"}}));
  validateGraph(graph,{registry,transformations});

  const providers=new ProviderRouter({
    reasoning_high:new OpenAIProvider({effort:"medium"}),
    reasoning_fast:new OpenAIProvider({effort:"medium"}),
  });
  const runner=new Runner({store,registry,prompts,providers,runLog,blobs,media:{images,renderer},logger:console});
  const executor=new GraphExecutor({runner,runLog,store,registry,transformations,logger:console});

  console.log("RFC 0010 visual benchmark");
  console.log(`script=${scriptId}`);
  console.log(`voice=${voiceId}`);
  console.log(`control=${controlId}`);
  console.log(`images=${images.id}`);
  console.log(`renderer=${renderer.id}`);
  console.log(`text_model=${env("FREELLMAPI_TEXT_MODEL")??"gemini-2.5-flash"}`);
  console.log(`fal_text_to_video=${env("FAL_TEXT_TO_VIDEO_MODEL")??"fal-ai/kling-video/v2.5-turbo/pro/text-to-video"}`);

  const result=await executor.start(graph,{script:scriptId,voice:voiceId,control_render:controlId});
  if(result.failures.length){
    for(const failure of result.failures) console.error(`FAILED ${failure.node_id}: ${failure.error}`);
    process.exitCode=1;
    return;
  }
  const reportId=result.outputs["benchmark_report"];
  const candidateId=result.outputs["candidate_render"];
  if(!reportId) throw new Error(`benchmark ended ${result.status} without benchmark_report`);
  const report=await store.require(reportId,{schema_id:"visual_benchmark_report"});
  const payload=report.payload as {pass:boolean;failures:string[];summary:Record<string,unknown>};
  console.log(`\nV2 render artifact: ${candidateId??"missing"}`);
  console.log(`benchmark report: ${reportId}`);
  console.log(`RESULT: ${payload.pass?"PASS":"FAIL"}`);
  if(payload.failures.length) for(const failure of payload.failures) console.log(`  - ${failure}`);
  console.table(payload.summary);
  const usage=rollup((await runLog.all()).filter((row)=>row.run_id===result.run_id));
  console.log(`cost $${usage.cost_usd.toFixed(4)}; artifacts in ${DATA}`);
  if(!payload.pass) process.exitCode=1;
}

main().catch((error)=>{ console.error(error); process.exit(1); });
