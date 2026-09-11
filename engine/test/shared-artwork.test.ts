import test from "node:test";
import assert from "node:assert/strict";
import { makeThumbnailWorker } from "../src/workers/thumbnail.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import type { Artifact } from "../src/artifact.ts";
import type { WorkerContext } from "../src/runner.ts";
test("thumbnail uses the exact episode artwork without another image generation", async()=>{
  const blobs=new MemoryBlobStore();
  const bytes=new Uint8Array([1,2,3]);
  const ref=await blobs.put(bytes,{role:"episode_background",media_type:"image/png"});
  let calls=0;
  const ctx={blobs,logger:console,attemptNumber:1,progress:async()=>{},media:{
    images:{generate:async()=>{calls++;throw new Error("must not generate");}},
    renderer:{renderThumbnail:async(req:{image:Uint8Array})=>{
      assert.deepEqual(req.image,bytes);
      return {bytes,media_type:"image/png",width:1280,height:720,background:"supplied"};
    }},
  }} as unknown as WorkerContext;
  await makeThumbnailWorker().execute({brief:{payload:{text:"TRY THIS",accent:"teal",art_prompt:"ignored"}} as Artifact,episode:{blobs:[ref]} as Artifact},ctx);
  assert.equal(calls,0);
});
