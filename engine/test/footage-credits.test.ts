import test from "node:test";
import assert from "node:assert/strict";
import {MemoryBlobStore} from "../src/blobs.ts";
import {FakePublishTarget} from "../src/providers/fake.ts";
import {makePublishWorker} from "../src/workers/publish.ts";
import type {Artifact} from "../src/artifact.ts";
import type {WorkerContext} from "../src/runner.ts";
test("footage attribution survives publishing and cannot be silently truncated",async()=>{
  const blobs=new MemoryBlobStore();
  const video=await blobs.put(new Uint8Array([1]),{role:"video"});
  const asset={credit:"Footage by Example",source_url:"https://example.com/clip",license_url:"https://example.com/license"};
  const credit=await blobs.put(new TextEncoder().encode(JSON.stringify([asset,asset])),{role:"footage_credits"});
  const inputs={
    video:{payload:{video_uri:video.uri,media_type:"video/mp4"},blobs:[video,credit]},
    seo:{payload:{title:"A title",description:"A description",tags:[]}},
    thumbnail:{payload:{}},
    qa:{payload:{verdict:"pass",failed:0,warned:0}}
  } as unknown as Record<string,Artifact>;
  const ctx={blobs,logger:console,progress:async()=>{}} as unknown as WorkerContext;
  const target=new FakePublishTarget();
  await makePublishWorker({target,privacy:"public"}).execute(inputs,ctx);
  assert.match(target.published[0]!.metadata.description!,/Footage by Example/);
  assert.match(target.published[0]!.metadata.description!,/not footage of the narrated events/);
  assert.equal(target.published[0]!.metadata.description!.split("Footage by Example").length-1,1);
  const limited=new FakePublishTarget({requirements:{max_description_chars:20}});
  await assert.rejects(()=>makePublishWorker({target:limited}).execute(inputs,ctx),/credits exceed/);
  assert.equal(limited.published.length,0);
});
