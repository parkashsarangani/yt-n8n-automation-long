import test from "node:test";
import assert from "node:assert/strict";
import { localSlot, localParts } from "../src/delivery-time.ts";
import { Scheduler } from "../src/scheduler.ts";
import { productionReady, startGrowthScheduler } from "../src/growth-scheduler.ts";
import { repairVisualCards, presentationErrors } from "../src/episode-presentation.ts";

test("bad decorative cards cannot reroll good narration or introduce invented text",()=>{
  const narration="Let me finish this thought, then I would like to hear yours.";
  const result=repairVisualCards({scenes:[{scene_index:0,narration,visual:{kind:"quote",title:"Claim",items:["He confessed to everything."]}}]}) as any;
  assert.equal(result.scenes[0].narration,narration);
  assert.deepEqual(presentationErrors(result),[]);
  assert.equal(result.scenes[0].visual.items[0],narration);
});

test("delivery gate releases only at 05:00 Berlin, including restart catch-up", async () => {
  let now=Date.parse("2026-09-14T02:59:00Z"), released=0;
  const run={run_id:"test",kind:"production",created_at:"2026-09-14T01:00:00Z",status:"waiting",failures:[],waiting:[{node_id:"editor_delivery"}]};
  const service={capabilities:()=>[{id:"editor_handoff",real:true}],listRuns:()=>[run],decide:async()=>{released++;run.waiting=[{node_id:"editor_review"}];}} as any;
  const scheduler=startGrowthScheduler(service,{now:()=>now});
  try{
    await scheduler.runNow("editor_delivery"); assert.equal(released,0);
    now+=60_000; await scheduler.runNow("editor_delivery"); assert.equal(released,1);
    await scheduler.runNow("editor_delivery"); assert.equal(released,1);
  }finally{scheduler.stop();}
});

test("05:00 Berlin delivery follows winter, summer and both DST transitions", () => {
  for (const [day, utc] of [["2026-01-15","04"],["2026-07-15","03"],["2026-03-29","03"],["2026-10-25","04"]]) {
    const slot = localSlot(Date.parse(day+"T00:00:00Z"),5,"Europe/Berlin");
    assert.equal(new Date(slot).toISOString(),day+"T"+utc+":00:00.000Z");
    assert.equal(localParts(slot).hour,5);
  }
  assert.equal(new Date(localSlot(Date.parse("2026-03-28T06:00:00Z"),5,"Europe/Berlin",true)).toISOString(),"2026-03-29T03:00:00.000Z");
});

test("failed daily work retries after fifteen minutes instead of waiting a day", async () => {
  let now=Date.parse("2026-09-14T01:00:00Z"), attempts=0;
  const scheduler=new Scheduler({now:()=>now, logger:{log(){},warn(){},error(){}},jobs:[{
    id:"produce",enabled:true,everyHours:24,localSchedule:{hour:3,timeZone:"Europe/Berlin"},retryMinutes:15,description:"test",
    async run(){if(++attempts===1)throw Error("temporary outage");}
  }]});
  await scheduler.tick();
  now+=14*60_000; await scheduler.tick(); assert.equal(attempts,1);
  now+=60_000; await scheduler.tick(); assert.equal(attempts,2);
  now+=60_000; await scheduler.tick(); assert.equal(attempts,2);
});

test("editor gates count as production readiness, failures do not", () => {
  for(const node_id of ["editor_delivery","editor_review"]) {
    assert.equal(productionReady({status:"waiting",waiting:[{node_id}],failures:[]} as any),true);
    assert.equal(productionReady({status:"waiting",waiting:[{node_id}],failures:[{error:"thumbnail failed"}]} as any),false);
  }
  assert.equal(productionReady({status:"waiting",waiting:[{node_id:"creative_viability"}],failures:[]} as any),false);
});
