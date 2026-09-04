import test from "node:test";
import assert from "node:assert/strict";
import { packageSeedOf, candidateOverallScore, viableCandidate, creativeFailure, creativeFailureKind, type DiscoveryCandidate } from "../src/growth-scheduler.ts";

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

test("creative terminal states authorize topic failover but infrastructure failures never do", () => {
  const parkedAbandon = { status: "waiting", waiting: [{ node_id: "creative_viability" }], failures: [] } as any;
  const blockedAbandon = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (ABANDON_TOPIC: weak premise)" }] } as any;
  const exhaustedRevision = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT)" }] } as any;
  const infrastructure = { status: "blocked", waiting: [], failures: [{ node_id: "render", error: "renderer unavailable" }] } as any;
  const technicalQa = { status: "waiting", waiting: [{ node_id: "approve_publish" }], failures: [] } as any;

  assert.equal(creativeFailureKind(parkedAbandon), "creative_viability", "a parked viability gate must be terminally abandoned, not treated as a generic retry");
  assert.equal(creativeFailureKind(blockedAbandon), "watchability");
  assert.equal(creativeFailureKind(exhaustedRevision), "watchability");
  assert.equal(creativeFailureKind(infrastructure), null);
  assert.equal(creativeFailureKind(technicalQa), null);

  assert.equal(creativeFailure(parkedAbandon), true);
  assert.equal(creativeFailure(blockedAbandon), true);
  assert.equal(creativeFailure(exhaustedRevision), true, "after service-level retries are exhausted the scheduler must advance the topic");
  assert.equal(creativeFailure(infrastructure), false);
  assert.equal(creativeFailure(technicalQa), false);
});
