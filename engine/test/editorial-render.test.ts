import test from "node:test";
import assert from "node:assert/strict";
import {makeRenderWorker} from "../src/workers/render.ts";
import {MemoryBlobStore} from "../src/blobs.ts";
import type {Artifact} from "../src/artifact.ts";
import type {WorkerContext} from "../src/runner.ts";
test("editorial renders neither generate nor revive synthetic episode artwork",async()=>{
  const blobs=new MemoryBlobStore();
  const audio=await blobs.put(new Uint8Array([1]),{role:"audio",media_type:"audio/wav"});
  let calls=0;
  const ctx={blobs,progress:async()=>{},logger:console,
    priorArtifact:{blobs:[{role:"episode_background",uri:"missing-old-art"}]},
    media:{images:{generate:async()=>{calls++;throw Error("unexpected image request");}},
      renderer:{id:"fake/render",render:async(req:{background_image?:Uint8Array})=>{
        assert.equal(req.background_image,undefined);
        return {video:new Uint8Array([1]),media_type:"video/mp4"};
      }}}
  } as unknown as WorkerContext;
  await makeRenderWorker().execute({
    script:{payload:{scenes:[{scene_index:0,narration:"Ask once."}]}} as Artifact,
    voice:{payload:{clips:[{scene_index:0,audio_uri:audio.uri,duration_sec:1}]}} as Artifact
  },ctx);
  assert.equal(calls,0);
});
