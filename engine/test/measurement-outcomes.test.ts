import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";
function fixture() {
  const svc=Object.create(VidGenService.prototype);
  svc.store={index:async()=>[{schema_id:"published_episode",artifact_id:"episode"}],get:async()=>({payload:{external_id:"fixture-video"}})};
  svc.analyticsProvider={fetchVisibility:async()=>({"fixture-video":"public"})};
  svc.measureGraph={graph_id:"measure",version:"1"};
  svc.runLog={};svc.closeRun=async()=>{};
  svc.executor={start:async()=>({status:"blocked",outputs:{}})};
  return svc;
}
test("blocked measurement is failed, never a successful zero-view observation",async()=>{
  const r=await fixture().measureAll();assert.equal(r.measured.length,0);assert.equal(r.failed.length,1);
});
test("visibility authorization failure is exposed rather than silently skipped",async()=>{
  const svc=fixture();svc.analyticsProvider.fetchVisibility=async()=>{throw new Error("403 insufficient scope");};
  const r=await svc.measureAll();assert.equal(r.skipped.length,0);assert.match(r.failed[0].error,/403/);
});
