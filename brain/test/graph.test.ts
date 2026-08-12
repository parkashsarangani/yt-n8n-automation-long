import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "../src/registry.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { loadGraph, validateGraph, GraphError, descendantsOf, type GraphDoc } from "../src/graph.ts";
import { parsePredicate, evaluatePredicate, PredicateError } from "../src/predicate.ts";
import type { Artifact } from "../src/artifact.ts";
import type { TransformationDef } from "../src/runner.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function deps() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  return { registry, transformations: agents as Map<string, TransformationDef> };
}

function graph(nodes: GraphDoc["nodes"]): GraphDoc {
  return { graph_id: "test", version: "1", nodes };
}

test("the shipped skeleton graph is statically valid", async () => {
  const g = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  const d = await deps();
  assert.doesNotThrow(() => validateGraph(g, d));
});

test("catches a mis-wired edge before a token is spent", async () => {
  const d = await deps();
  // script_writer consumes a story; this hands it an intent.
  const bad = graph([
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "script", transformation: "script_writer", in: ["intent"] },
  ]);
  assert.throws(
    () => validateGraph(bad, d),
    /emits "intent", but "script_writer" expects "story"/,
  );
});

test("catches wrong arity", async () => {
  const d = await deps();
  const bad = graph([
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "story", transformation: "story_architect", in: ["intent"] },
    { id: "script", transformation: "script_writer", in: ["story", "intent"] },
  ]);
  assert.throws(() => validateGraph(bad, d), /supplies 2 input\(s\) but "script_writer" consumes 1/);
});

test("catches cycles, dangling references, and unknown transformations", async () => {
  const d = await deps();
  assert.throws(
    () =>
      validateGraph(
        graph([
          { id: "a", transformation: "story_architect", in: ["b"] },
          { id: "b", transformation: "script_writer", in: ["a"] },
        ]),
        d,
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      validateGraph(
        graph([{ id: "story", transformation: "story_architect", in: ["nope"] }]),
        d,
      ),
    /references unknown input "nope"/,
  );
  assert.throws(
    () =>
      validateGraph(
        graph([
          { id: "intent", type: "input", schema_id: "intent" },
          { id: "x", transformation: "fact_checker", in: ["intent"] },
        ]),
        d,
      ),
    /unknown transformation "fact_checker"/,
  );
});

test("rejects node types RFC 0005 specifies but we have not built", async () => {
  const d = await deps();
  const bad = { graph_id: "t", version: "1", nodes: [{ id: "f", type: "fanout", in: [] }] };
  assert.throws(
    () => validateGraph(bad as unknown as GraphDoc, d),
    /fanout\/select are specified in RFC 0005 but not implemented/,
  );
});

test("rejects an unparseable auto-pass predicate", async () => {
  const d = await deps();
  const bad = graph([
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "story", transformation: "story_architect", in: ["intent"] },
    {
      id: "gate",
      type: "human_gate",
      in: ["story"],
      policy: { auto_pass_if: "confidence.overall is basically fine" },
    },
  ]);
  assert.throws(() => validateGraph(bad, d), /human_gate "gate"/);
});

test("descendantsOf finds the blocked subtree", async () => {
  const g = graph([
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "story", transformation: "story_architect", in: ["intent"] },
    { id: "script", transformation: "script_writer", in: ["story"] },
  ]);
  assert.deepEqual([...descendantsOf(g, new Set(["story"]))], ["script"]);
  assert.deepEqual([...descendantsOf(g, new Set(["script"]))], []);
});

// -- predicates ---------------------------------------------------------

const ARTIFACT = {
  artifact_id: "sha256:" + "0".repeat(64),
  schema_id: "story",
  schema_version: "1.0.0",
  produced_by: { transformation: "story_architect", version: "1", run_id: "r" },
  parents: [],
  confidence: { overall: 0.93, dimensions: { novelty: 0.7 } },
  created_at: "2026-08-10T00:00:00.000Z",
  labels: { variant: "a" },
  payload: { acts: [1, 2, 3] },
} as unknown as Artifact;

test("predicates read artifact fields, including nested and .length", () => {
  assert.equal(evaluatePredicate("confidence.overall >= 0.9", ARTIFACT), true);
  assert.equal(evaluatePredicate("confidence.overall >= 0.95", ARTIFACT), false);
  assert.equal(evaluatePredicate("confidence.dimensions.novelty < 0.8", ARTIFACT), true);
  assert.equal(evaluatePredicate("payload.acts.length > 2", ARTIFACT), true);
  assert.equal(evaluatePredicate('labels.variant == "a"', ARTIFACT), true);
  assert.equal(evaluatePredicate('labels.variant != "a"', ARTIFACT), false);
});

test("an unresolvable path is false, not a crash", () => {
  // A missing confidence should route to a human, not abort the run.
  assert.equal(evaluatePredicate("confidence.nope >= 0.5", ARTIFACT), false);
});

test("predicates are not a general expression language", () => {
  assert.throws(() => parsePredicate("confidence.overall"), PredicateError);
  assert.throws(() => parsePredicate("1 + 1 == 2"), PredicateError);
  assert.throws(() => parsePredicate("process.exit(1) > 0"), PredicateError);
  assert.throws(() => evaluatePredicate('confidence.overall >= "high"', ARTIFACT), PredicateError);
});
