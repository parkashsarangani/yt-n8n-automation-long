/**
 * Thumbnail worker: best-effort artwork, gradient fallback.
 *
 * Typography comes from long-compose; artwork comes from the image model
 * when one is configured and the brief has a usable prompt. Neither a failed
 * generation nor a missing provider blocks the run — they degrade to the
 * renderer's gradient background with a warning, so a thumbnail always ships.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeRenderer, FakeImageProvider } from "../src/providers/fake.ts";
import { Runner } from "../src/runner.ts";
import { makeThumbnailWorker } from "../src/workers/index.ts";
import type { Artifact } from "../src/artifact.ts";
import type { WorkerContext } from "../src/runner.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
test("new prompt schema accepts empty overlays and rejects legacy query fields",async()=>{
  const h=await harness();
  const brief={image_prompt:"A candid photographic scene of a colleague pausing at a desk.",text:"",accent:"#FFFFFF",rationale:"The pause conveys the unresolved conflict."};
  h.registry.validate("thumbnail_brief","2.0.0",brief);
  assert.throws(()=>h.registry.validate("thumbnail_brief","2.0.0",{...brief,background_query:"office"}));
  const saved=await h.store.put({schema_id:"thumbnail_brief",schema_version:"2.0.0",payload:brief,
    produced_by:{transformation:"thumbnail_designer",version:"4",run_id:"new-thumbnail",provider:null}});
  const throughRunner=await h.runner.run(makeThumbnailWorker(),[saved.artifact.artifact_id]);
  assert.equal((throughRunner.artifact.payload as ThumbPayload).text,"");
  const out=await makeThumbnailWorker().execute({brief:{payload:brief} as Artifact},{
    blobs:h.blobs,media:{renderer:h.renderer,images:h.images},logger:silent(),progress:async()=>{}
  } as unknown as WorkerContext);
  assert.equal(h.images!.prompts[0],brief.image_prompt);
  assert.equal(h.renderer.thumbnailRequests[0]!.text,"");
  assert.ok(out.blobs?.some(b=>b.role==="thumbnail_artwork"));
  const prompt=out.blobs!.find(b=>b.role==="thumbnail_prompt")!;
  assert.equal(JSON.parse(new TextDecoder().decode(await h.blobs.get(prompt.uri))).status,"candidate");
});
test("OCR rejection repairs once and exports only accepted artwork",async()=>{
  const renderer=new FakeRenderer();
  const original=renderer.renderThumbnail.bind(renderer);
  let calls=0;
  renderer.renderThumbnail=async req=>({...await original(req),background:++calls===1?"gradient":"supplied"});
  const h=await harness({renderer});
  const out=await makeThumbnailWorker().execute({brief:h.brief},{
    blobs:h.blobs,media:{renderer,images:h.images},logger:silent(),progress:async()=>{}
  } as unknown as WorkerContext);
  assert.equal(h.images!.prompts.length,2);
  assert.match(h.images!.prompts[1]!,/Repair:/);
  assert.equal((out.payload as ThumbPayload).background,"supplied");
  assert.equal(out.blobs!.filter(b=>b.role==="thumbnail_artwork").length,1);
});
test("two failed generations export explicit replacement status and no artwork",async()=>{
  const h=await harness({images:new FakeImageProvider(()=>true)});
  const out=await makeThumbnailWorker().execute({brief:h.brief},{
    blobs:h.blobs,media:{renderer:h.renderer,images:h.images},logger:silent(),progress:async()=>{}
  } as unknown as WorkerContext);
  assert.equal(h.images!.prompts.length,2);
  assert.equal(out.blobs!.some(b=>b.role==="thumbnail_artwork"),false);
  const manifest=JSON.parse(new TextDecoder().decode(await h.blobs.get(out.blobs!.find(b=>b.role==="thumbnail_prompt")!.uri)));
  assert.equal(manifest.status,"needs_editor_replacement");
  assert.equal(manifest.attempts.length,2);
});
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

const BRIEF = {
  text: "DON'T OPEN IT",
  emphasis: "OPEN IT",
  background_query: "a glowing school locker at night",
  accent: "#FFD34D",
  rationale: "The reaction plus unexplained glowing locker forms one readable visual question at small size.",
  alternatives: ["WHAT'S INSIDE?", "IT WAS LOCKED"],
};

interface ThumbPayload {
  thumbnail_uri: string;
  media_type: string;
  width: number;
  height: number;
  text: string;
  emphasis?: string;
  background: "supplied" | "gradient";
  background_query?: string;
  bytes?: number;
}

async function harness(opts: {
  renderer?: FakeRenderer;
  images?: FakeImageProvider | null;
  brief?: Partial<typeof BRIEF>;
} = {}) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-thumb-")),
    registry,
  );
  const blobs = new MemoryBlobStore();
  const renderer = opts.renderer ?? new FakeRenderer();
  const images = opts.images === null ? undefined : (opts.images ?? new FakeImageProvider());

  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs,
    media: { renderer, ...(images ? { images } : {}) },
  });

  const brief = (
    await store.put({
      schema_id: "thumbnail_brief",
      schema_version: "1.1.0",
      payload: { ...BRIEF, ...(opts.brief ?? {}) },
      produced_by: {
        transformation: "thumbnail_designer",
        version: "1",
        run_id: "t",
        provider: null,
      },
    })
  ).artifact;

  return { registry, store, blobs, runner, renderer, images, brief };
}

const run = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.runner.run(makeThumbnailWorker(), [h.brief.artifact_id])).artifact
    .payload as ThumbPayload;

test("a gradient episode does not suppress thumbnail artwork generation", async () => {
  const h = await harness();
  const out = await makeThumbnailWorker().execute({
    brief: h.brief,
    episode: { payload: { video_uri: "draft" }, blobs: [] } as unknown as Artifact,
  }, { blobs: h.blobs, media: { renderer: h.renderer, images: h.images },
    logger: silent(), progress: async () => {} } as unknown as WorkerContext);
  assert.equal(h.images!.prompts.length, 1);
  assert.ok(h.renderer.thumbnailRequests[0]!.image);
  assert.equal((out.payload as ThumbPayload).background, "supplied");
});

test("episode artwork never overrides the standalone thumbnail prompt", async () => {
  const h = await harness();
  const bytes = new Uint8Array([1,2,3]);
  const background = await h.blobs.put(bytes, {role:"episode_background",media_type:"image/png"});
  await makeThumbnailWorker().execute({brief:h.brief,
    episode:{payload:{video_uri:"draft"},blobs:[background]} as unknown as Artifact,
  }, {blobs:h.blobs,media:{renderer:h.renderer,images:h.images},logger:silent(),progress:async()=>{}} as unknown as WorkerContext);
  assert.equal(h.images!.prompts.length,1);
  assert.notDeepEqual(h.renderer.thumbnailRequests[0]!.image,bytes);
});

test("composites deterministic text over generated artwork", async () => {
  const h = await harness();
  const out = await run(h);

  assert.equal(h.images!.prompts.length, 1);
  assert.ok(h.images!.prompts[0]!.includes(BRIEF.background_query));
  assert.equal(h.images!.prompts[0],BRIEF.background_query,"no inherited style wrapper");

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.accent, BRIEF.accent);
  assert.equal(sent.emphasis, BRIEF.emphasis);
  assert.ok(sent.image, "the generated artwork should reach the renderer");

  assert.equal(out.background, "supplied");
  assert.equal(out.text, BRIEF.text);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
  assert.match(out.thumbnail_uri, /^blob:\/\/sha256:[0-9a-f]{64}$/);
});

test("the rendered bytes are actually stored and retrievable", async () => {
  const h = await harness();
  const out = await run(h);

  const bytes = await h.blobs.get(out.thumbnail_uri);
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes.byteLength, out.bytes);
});

test("artwork generation failure degrades to a gradient instead of blocking the run", async () => {
  const h = await harness({ images: new FakeImageProvider(() => true) });
  const out = await run(h);

  assert.equal(out.background, "gradient");
  assert.equal(h.renderer.thumbnailRequests[0]!.image, undefined);
});

test("no image provider degrades to a gradient instead of blocking the run", async () => {
  const h = await harness({ images: null });
  const out = await run(h);

  assert.equal(out.background, "gradient");
});

test("a renderer outage does fail the node — there is nothing to degrade to", async () => {
  const h = await harness({ renderer: new FakeRenderer("compose is down") });
  await assert.rejects(() => run(h), /compose is down/);

  assert.equal(
    (await h.store.index()).filter((r) => r.schema_id === "thumbnail").length,
    0,
    "a failed render must not leave a thumbnail artifact behind",
  );
});

test("the artifact validates against the registry schema", async () => {
  const h = await harness();
  const out = await run(h);
  assert.doesNotThrow(() =>
    h.registry.validate("thumbnail", h.registry.resolveVersion("thumbnail"), out),
  );
});

test("an identical brief produces an identical artifact id", async () => {
  const a = await harness();
  const b = await harness();
  const first = await a.runner.run(makeThumbnailWorker(), [a.brief.artifact_id]);
  const second = await b.runner.run(makeThumbnailWorker(), [b.brief.artifact_id]);

  assert.equal(first.artifact.artifact_id, second.artifact.artifact_id);
});

test("the emphasised phrase reaches the renderer, not just the text", async () => {
  const h = await harness();
  await run(h);

  const sent = h.renderer.thumbnailRequests[0]!;
  assert.equal(sent.text, BRIEF.text);
  assert.equal(sent.emphasis, BRIEF.emphasis);
});

test("a brief without emphasis still renders", async () => {
  const h = await harness({ brief: { emphasis: undefined } });
  const out = await run(h);

  assert.equal(out.text, BRIEF.text);
  assert.equal(h.renderer.thumbnailRequests[0]!.emphasis, undefined);
});

test("generation errors retain actionable detail without credentials",async()=>{
  const {thumbnailErrorDetail}=await import("../src/workers/thumbnail.ts");
  assert.equal(thumbnailErrorDetail(new Error("provider 401 api_key=secret Bearer abc")),"provider 401 api_key=[REDACTED] Bearer [REDACTED]");
  const h=await harness({images:new FakeImageProvider(()=>true)});
  const out=await makeThumbnailWorker().execute({brief:h.brief},{
    blobs:h.blobs,media:{renderer:h.renderer,images:h.images},logger:silent(),progress:async()=>{}
  } as unknown as WorkerContext);
  const manifest=JSON.parse(new TextDecoder().decode(await h.blobs.get(out.blobs!.find(b=>b.role==="thumbnail_prompt")!.uri)));
  assert.equal(manifest.attempts[0].outcome,"generation_failure");
  assert.match(manifest.attempts[0].error,/fake image failed/);
});
test("OCR service failure survives HTTP fallback and avoids a second image charge",async()=>{
  const {ComposeRenderer}=await import("../src/providers/compose.ts");
  const h=await harness();
  let calls=0;
  const renderer=new ComposeRenderer({baseUrl:"http://fixture",fetchImpl:(async()=>{
    calls++;
    return calls===1
      ? new Response(JSON.stringify({error:"Artwork OCR screening failed; repair the OCR service before retrying"}),{status:500})
      : Response.json({success:true,image_base64:Buffer.from("png").toString("base64"),background:"gradient"});
  }) as typeof fetch});
  const warnings:string[]=[];
  const out=await makeThumbnailWorker().execute({brief:h.brief},{
    blobs:h.blobs,media:{renderer,images:h.images},logger:{...silent(),warn:(s:string)=>warnings.push(s)},progress:async()=>{}
  } as unknown as WorkerContext);
  assert.equal(h.images!.prompts.length,1);
  assert.equal(calls,2);
  const manifest=JSON.parse(new TextDecoder().decode(await h.blobs.get(out.blobs!.find(b=>b.role==="thumbnail_prompt")!.uri)));
  assert.equal(manifest.status,"needs_editor_replacement");
  assert.equal(manifest.attempts[0].outcome,"render_service_failure");
  assert.match(manifest.attempts[0].error,/500.*OCR screening failed/);
  assert.ok(warnings.some(s=>s.includes("OCR screening failed")));
});
