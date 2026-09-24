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
  assert.match(r.failed[0].error,/measurement blocked/);
});
test("missing analytics configuration is an actionable failure rather than an unknown-visibility skip",async()=>{
  const svc=fixture();svc.analyticsProvider=undefined;
  const r=await svc.measureAll();assert.equal(r.skipped.length,0);assert.match(r.failed[0].error,/not configured/);
});
test("visibility authorization failure is exposed rather than silently skipped",async()=>{
  const svc=fixture();svc.analyticsProvider.fetchVisibility=async()=>{throw new Error("403 insufficient scope");};
  const r=await svc.measureAll();assert.equal(r.skipped.length,0);assert.match(r.failed[0].error,/403/);
});
test("a video too new for YouTube Analytics is skipped as settling, not failed",async()=>{
  // Production 2026-09-21..23: the newest uploads returned no rows every day.
  const svc=fixture();let started=0;svc.executor={start:async()=>{started++;return {status:"blocked",outputs:{}};}};
  svc.store.get=async()=>({payload:{external_id:"fixture-video",published_at:new Date(Date.now()-36*3600_000).toISOString()}});
  const r=await svc.measureAll();
  assert.deepEqual(r.skipped,[{external_id:"fixture-video",visibility:"settling"}]);assert.equal(r.failed.length,0);assert.equal(started,0);
});
test("a settled video is measured and its empty result still fails loudly",async()=>{
  const svc=fixture();
  svc.store.get=async()=>({payload:{external_id:"fixture-video",published_at:new Date(Date.now()-4*86400_000).toISOString()}});
  const r=await svc.measureAll();assert.equal(r.skipped.length,0);assert.equal(r.failed.length,1);
});
