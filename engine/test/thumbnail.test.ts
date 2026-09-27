/**
 * Thumbnail worker: a text-on-gradient placeholder for the editor's Drive
 * package. Generated artwork was retired (2026-09-27); only the editor's
 * thumbnail-final is published. Typography comes from long-compose.
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
import { FakeRenderer } from "../src/providers/fake.ts";
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
    blobs:h.blobs,media:{renderer:h.renderer},logger:silent(),progress:async()=>{}
  } as unknown as WorkerContext);
  assert.equal(h.renderer.thumbnailRequests.at(-1)!.text,"");
  assert.equal(h.renderer.thumbnailRequests.at(-1)!.image,undefined,"no artwork is generated any more");
  const notes=JSON.parse(new TextDecoder().decode(await h.blobs.get(out.blobs!.find(b=>b.role==="thumbnail_prompt")!.uri)));
  assert.equal(notes.status,"placeholder");
  assert.equal(notes.art_direction,brief.image_prompt,"the designer's idea is kept as a note for the editor");
  assert.match(notes.note,/thumbnail-final[.]png/);
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
  brief?: Partial<typeof BRIEF>;
} = {}) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-thumb-")),
    registry,
  );
  const blobs = new MemoryBlobStore();
  const renderer = opts.renderer ?? new FakeRenderer();

  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs,
    media: { renderer },
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

  return { registry, store, blobs, runner, renderer, brief };
}

const run = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.runner.run(makeThumbnailWorker(), [h.brief.artifact_id])).artifact
    .payload as ThumbPayload;

test("the rendered bytes are actually stored and retrievable", async () => {
  const h = await harness();
  const out = await run(h);

  const bytes = await h.blobs.get(out.thumbnail_uri);
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes.byteLength, out.bytes);
});

test("the placeholder is a gradient: no artwork is ever generated", async () => {
  const h = await harness();
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
