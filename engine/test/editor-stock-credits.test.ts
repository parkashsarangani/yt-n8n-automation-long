import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";
import { MemoryBlobStore } from "../src/blobs.ts";

test("an editor cut retains original stock credits, without attaching stale draft captions", async () => {
  const service = Object.create(VidGenService.prototype);
  const credits = {role:"footage_credits",uri:"credits",media_type:"application/json"};
  const state = {completedOutputs:new Map([["render","draft"]]),presetOutputs:{}};
  service.runs = new Map([["run-test",state]]);
  service.blobs = new MemoryBlobStore();
  let stored: any;
  service.store = {
    get: async (id: string) => { assert.equal(id,"draft"); return {blobs:[credits,{role:"captions",uri:"old-captions"}]}; },
    put: async (input: unknown) => { stored=input; return {artifact:{artifact_id:"edited"}}; },
  };
  await service.supplyEditorCut("run-test",{bytes:new Uint8Array([1]),media_type:"video/mp4",scene_count:3,degraded_scenes:0});
  assert.deepEqual(stored.blobs.map((b: any)=>b.role),["video","footage_credits"]);
  assert.deepEqual(stored.blobs[1],credits);
  assert.equal((state.presetOutputs as any).finalize_video,"edited");
});
