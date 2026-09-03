import test from "node:test";
import assert from "node:assert/strict";
import { briefWithPackageSeed, candidateOverallScore, viableCandidate, creativeFailure, type DiscoveryCandidate } from "../src/growth-scheduler.ts";

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

test("package seed remains valid JSON inside intent's 2000-char contract", () => {
  const c = candidate(); c.evidence = "e".repeat(1000);
  const brief = briefWithPackageSeed(c);
  assert.ok(brief.length <= 2000); assert.match(brief, /^RFC0009_PACKAGE_JSON:/);
  const decoded = JSON.parse(brief.slice("RFC0009_PACKAGE_JSON:".length));
  assert.equal(decoded.genre, "drama"); assert.match(decoded.opening_line, /belt twice/);
});

test("only explicit creative abandonment authorizes topic failover", () => {
  const parkedAbandon = { status: "waiting", waiting: [{ node_id: "creative_viability" }], failures: [] } as any;
  const blockedAbandon = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (ABANDON_TOPIC: weak premise)" }] } as any;
  const revision = { status: "blocked", waiting: [], failures: [{ node_id: "watchability_release", error: "watchability release blocked (REVISE_SCRIPT)" }] } as any;
  const infrastructure = { status: "blocked", waiting: [], failures: [{ node_id: "render", error: "renderer unavailable" }] } as any;
  assert.equal(creativeFailure(parkedAbandon), true); assert.equal(creativeFailure(blockedAbandon), true);
  assert.equal(creativeFailure(revision), false); assert.equal(creativeFailure(infrastructure), false);
});
