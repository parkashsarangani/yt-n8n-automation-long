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
  inputs.script={payload:{scenes:[0,1,2].map(scene_index=>({scene_index,point:`[scenario] Chapter ${scene_index}`}))}} as unknown as Artifact;
  inputs.voice={payload:{clips:[0,1,2].map(scene_index=>({scene_index,duration_sec:20}))}} as unknown as Artifact;
  const chapterTarget=new FakePublishTarget();
  await makePublishWorker({target:chapterTarget}).execute(inputs,ctx);
  const published=chapterTarget.published[0]!.metadata.description!;
  assert.ok(published.startsWith("A description\n\nChapters\n00:00 Chapter 0"));
  assert.match(published,/00:40 Chapter 2/);
  const wouldTruncate=new FakePublishTarget({requirements:{max_description_chars:published.length-1}});
  const warnings:string[]=[];
  await makePublishWorker({target:wouldTruncate}).execute(inputs,{...ctx,logger:{...console,warn:(message:string)=>warnings.push(message)}});
  assert.equal(wouldTruncate.published[0]!.metadata.description,target.published[0]!.metadata.description);
  assert.ok(warnings.some(message=>message.includes("chapters omitted")));
  const proseAndCredits=target.published[0]!.metadata.description!;
  const exact=new FakePublishTarget({requirements:{max_description_chars:proseAndCredits.length}});
  await makePublishWorker({target:exact}).execute(inputs,ctx);
  assert.equal(exact.published[0]!.metadata.description,proseAndCredits);
  const overflow=new FakePublishTarget({requirements:{max_description_chars:proseAndCredits.length-1}});
  await assert.rejects(()=>makePublishWorker({target:overflow}).execute(inputs,ctx),/approved prose/);
  assert.equal(overflow.published.length,0);
});
