import test from "node:test";
import assert from "node:assert/strict";
import {
  packageSeedOf,
  candidateOverallScore,
  viableCandidate,
  creativeFailure,
  creativeFailureKind,
  watchabilityRetryState,
  startGrowthScheduler,
  type DiscoveryCandidate,
} from "../src/growth-scheduler.ts";

function candidate(overall = 0.8): DiscoveryCandidate {
  return {
    brief: "A dismissed mechanic warns everyone that a machine is about to fail, then becomes the only person who can repair it.", genre: "drama",
    angle: "Underestimation becomes visible vindication after a concrete failure.", target_audience: "Adults who enjoy workplace reversal stories",
    curiosity_gap: "Why the ignored mechanic knew the failure was coming", emotional_engine: "injustice to anxiety to vindication",
    opening_visual: "A mechanic pointing at a frayed belt while a supervisor waves him away and the machine keeps running.", opening_line: "He pointed at the belt twice. His boss laughed the second time.",
    title_concepts: [{ family: "curiosity", title: "The Mechanic Nobody Listened To" }, { family: "conflict", title: "His Boss Laughed at the Warning" }, { family: "reversal", title: "Then the Machine Finally Broke" }],
    thumbnail_concepts: [{ family: "curiosity", concept: "Ignored mechanic beside visibly frayed belt" }, { family: "conflict", concept: "Supervisor dismissing mechanic beside running machine" }, { family: "reversal", concept: "Mechanic repairing machine while coworkers watch" }],
    scores: { clickability: 0.75, story_potential: 0.78, audience_size: 0.8, overall },
  };
}

test("produce targets 9pm Europe/Berlin by resolved UTC hour, not a hardcoded US-timed default", async () => {
  const service = { listRuns: () => [], capabilities: () => [] } as any;
  const previous = {
    hourUtc: process.env["SCHEDULE_PRODUCE_HOUR_UTC"],
    timezone: process.env["SCHEDULE_PRODUCE_TIMEZONE"],
    localHour: process.env["SCHEDULE_PRODUCE_LOCAL_HOUR"],
  };
  try {
    delete process.env["SCHEDULE_PRODUCE_HOUR_UTC"];
    delete process.env["SCHEDULE_PRODUCE_TIMEZONE"];
    delete process.env["SCHEDULE_PRODUCE_LOCAL_HOUR"];
    const scheduler = startGrowthScheduler(service);
    try {
      const produce = scheduler.status().find((j) => j.id === "produce")!;
      // Berlin is UTC+1 or UTC+2 depending on the date this test happens to
      // run; either way 9pm local is 19:00 or 20:00 UTC, never the old fixed
      // "always 19:00" default that drifted an hour every DST change.
      assert.match(produce.description, /targeting 9pm Europe\/Berlin \(currently (19|20):00 UTC\)/);
    } finally { scheduler.stop(); }

    // An explicit SCHEDULE_PRODUCE_HOUR_UTC still wins as a literal override.
    process.env["SCHEDULE_PRODUCE_HOUR_UTC"] = "5";
    const pinned = startGrowthScheduler(service);
    try {
      assert.match(pinned.status().find((j) => j.id === "produce")!.description, /currently 5:00 UTC/);
    } finally { pinned.stop(); }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = key === "hourUtc" ? "SCHEDULE_PRODUCE_HOUR_UTC" : key === "timezone" ? "SCHEDULE_PRODUCE_TIMEZONE" : "SCHEDULE_PRODUCE_LOCAL_HOUR";
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
  }
});

test("scheduled measurement failures remain visible in job health", async () => {
  const service={listRuns:()=>[],capabilities:()=>[{id:"analytics",real:true}],measureAll:async()=>({measured:[],skipped:[],failed:[{external_id:"episode",error:"403 insufficient scope"}]})} as any;
  const scheduler=startGrowthScheduler(service);
  try {
    await scheduler.runNow("measure");
    assert.match(scheduler.status().find(job=>job.id==="measure")!.last_error!,/403 insufficient scope/);
  } finally {scheduler.stop();}
});

test("viability floor rejects weak packages before production spend", () => {
  assert.equal(viableCandidate(candidate()), true);
  const weak = candidate(); weak.scores!.story_potential = 0.4;
  assert.equal(viableCandidate(weak), false); assert.equal(candidateOverallScore(candidate(0.91)), 0.91);
});

// The old version of this asserted the scheduler emitted RFC0009_PACKAGE_JSON:
// -- which is precisely the marker the growth_packager prompt does NOT read.
// The test passed, the contract was broken, and the tournament winner was
// silently discarded on every scheduled run. Assert the typed field instead.
test("the tournament winner becomes a typed package seed, not prose", () => {
  const seed = packageSeedOf(candidate());
  assert.ok(seed, "a complete candidate must produce a seed");
  assert.match(seed!.opening_line, /belt twice/);
  assert.equal(seed!.title_concepts.length, 3);
  assert.equal(seed!.thumbnail_concepts.length, 3);
  assert.deepEqual(
    seed!.title_concepts.map((v) => v.family).sort(),
    ["conflict", "curiosity", "reversal"],
    "all three packaging families must survive into the seed",
  );
});

test("a candidate missing package fields runs as a plain brief instead of failing", () => {
  const partial = candidate();
  delete partial.curiosity_gap;
  assert.equal(packageSeedOf(partial), undefined, "manual/UI briefs have no tournament behind them");
});

test("watchability failover starts only after the bounded final evaluation", () => {
  const retrying = {
    status: "blocked", waiting: [],
    failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 2): average=0.740" }],
  } as any;
  const exhausted = {
    status: "blocked", waiting: [],
    failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 3): average=0.740" }],
  } as any;
  const packageContract = {
    status: "blocked", waiting: [],
    failures: [{ node_id: "watchability_release", error: "watchability release blocked (PACKAGE_CONTRACT): selected title does not match family" }],
  } as any;

  assert.equal(watchabilityRetryState(retrying), "retrying", "an intermediate blocked status belongs to the same run's unattended retry loop");
  assert.equal(watchabilityRetryState(exhausted), "exhausted", "the third evaluation is the bounded terminal creative failure");
  assert.equal(watchabilityRetryState(packageContract), null, "a structural package failure must never be disguised as creative exhaustion");
  assert.equal(creativeFailureKind(retrying), null, "candidate N+1 must not start while candidate N is still retrying");
  assert.equal(creativeFailureKind(exhausted), "watchability");
  assert.equal(creativeFailureKind(packageContract), null);
});

test("creative terminal states authorize topic failover but infrastructure failures never do", () => {
  const parkedAbandon = { status: "waiting", waiting: [{ node_id: "creative_viability" }], failures: [] } as any;
  const blockedAbandon = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (ABANDON_TOPIC: weak premise; attempt 3)" }] } as any;
  const exhaustedRevision = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 3)" }] } as any;
  const infrastructure = { status: "blocked", waiting: [], failures: [{ node_id: "render", error: "renderer unavailable" }] } as any;
  const technicalQa = { status: "waiting", waiting: [{ node_id: "approve_publish" }], failures: [] } as any;
  const packageContract = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (PACKAGE_CONTRACT): corrupt family lineage" }] } as any;

  assert.equal(creativeFailureKind(parkedAbandon), "creative_viability", "a parked viability gate must be terminally abandoned, not treated as a generic retry");
  assert.equal(creativeFailureKind(blockedAbandon), "watchability");
  assert.equal(creativeFailureKind(exhaustedRevision), "watchability");
  assert.equal(creativeFailureKind(infrastructure), null);
  assert.equal(creativeFailureKind(technicalQa), null);
  assert.equal(creativeFailureKind(packageContract), null, "topic substitution must not conceal a package-contract bug");

  assert.equal(creativeFailure(parkedAbandon), true);
  assert.equal(creativeFailure(blockedAbandon), true);
  assert.equal(creativeFailure(exhaustedRevision), true, "after service-level retries are exhausted the scheduler must advance the topic");
  assert.equal(creativeFailure(infrastructure), false);
  assert.equal(creativeFailure(technicalQa), false);
  assert.equal(creativeFailure(packageContract), false);
});

test("scheduled production ignores transient watchability blocks, then advances after true exhaustion", async () => {
  const first = candidate(0.92);
  first.brief = "The first ranked story repeatedly misses the opening promise despite several serious rewrites.";
  const second = candidate(0.84);
  second.brief = "The second ranked story clears its creative bar and becomes the episode produced this cycle.";

  const started: string[] = [];
  let firstReads = 0;
  const fakeService = {
    capabilities: () => [],
    listRuns: () => [],
    discoverTopics: async () => ({ candidates: { candidates: [first, second] }, history_count: 0, measured_episodes: 0 }),
    startRun: async (brief: string) => {
      started.push(brief);
      return started.length === 1 ? "run_first" : "run_second";
    },
    getRun: (runId: string) => {
      if (runId === "run_second") {
        return { status: "completed", waiting: [], failures: [], kind: "production", created_at: new Date().toISOString() };
      }
      firstReads++;
      // Stay transiently blocked for more than the old poll-count stability
      // threshold. The scheduler must NOT mistake this for final exhaustion.
      if (firstReads <= 3) {
        return {
          status: "blocked", waiting: [],
          failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 2): average=0.740" }],
        };
      }
      if (firstReads === 4) return { status: "running", waiting: [], failures: [] };
      return {
        status: "blocked", waiting: [],
        failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT; attempt 3): average=0.769" }],
      };
    },
    decide: async () => {},
    measureAll: async () => ({ measured: [], skipped: [], failed: [] }),
  } as any;

  const scheduler = startGrowthScheduler(fakeService, { pollMs: 1, maxWaitMs: 100 });
  try {
    await scheduler.runNow("produce");
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(started, [first.brief, second.brief], "candidate 2 starts exactly once, and only after candidate 1 reaches the bounded final evaluation");
  assert.ok(firstReads >= 6, "the scheduler must observe the bounded final state rather than the earlier transient block");
  assert.equal(scheduler.status().find((j) => j.id === "produce")?.last_error, null);
});
