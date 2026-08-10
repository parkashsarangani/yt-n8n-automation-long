# RFC 0005: Execution Graph

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

Two positions were argued during design. One: the production topology is known and stable
(research → story → script → assets → voice → timeline → render → publish), so a fixed state
machine is correct and a runtime planner trades away reproducibility for flexibility we cannot
name. Two: the topology *will* change — inserting legal review, generating three story variants
and predicting a winner, adding audience prediction before scripting — so the graph must not be
hardcoded.

These reconcile completely once the graph is **data**. The disagreement was only ever about
whether a model invents the topology at runtime.

## Problem

How is the sequence of transformations expressed, who executes it, and how do human checkpoints
and reproducibility fit?

## Decision

### The graph is a declarative, versioned document

A production graph is data — reviewable, diffable, and pinned per run. It is not code, and it
is not n8n node wiring.

```jsonc
{
  "graph_id": "longform.v3",
  "nodes": [
    { "id": "research",   "transformation": "research",        "in": ["intent"] },
    { "id": "factcheck",  "transformation": "fact_checker",    "in": ["research"] },
    { "id": "story",      "transformation": "story_architect", "in": ["factcheck"] },
    { "id": "approve",    "type": "human_gate", "in": ["story"],
      "policy": { "auto_pass_if": "confidence.overall >= 0.9", "timeout": "24h", "on_timeout": "hold" } },
    { "id": "script",     "transformation": "script_writer",   "in": ["approve"] },
    { "id": "visualplan", "transformation": "visual_planner",  "in": ["script"] },
    { "id": "assets",     "transformation": "asset_collector", "in": ["visualplan"] },
    { "id": "voice",      "transformation": "voice",           "in": ["script"] },
    { "id": "timeline",   "transformation": "timeline_composer","in": ["assets", "voice"] },
    { "id": "qa",         "transformation": "qa_suite",        "in": ["timeline"] },
    { "id": "render",     "transformation": "render",          "in": ["qa"] },
    { "id": "publish",    "transformation": "publish",         "in": ["render"],
      "with": { "target": "youtube" } }
  ]
}
```

Properties that follow:

- **Edges are artifact dependencies**, so `voice` and `assets` are independent and the executor
  may run them concurrently without anyone declaring parallelism.
- **A run pins `graph_id@version`.** Reproducing a build means replaying the same graph version
  over the same input artifacts — the missing half of RFC 0001's reproducibility guarantee.
- **Changing topology is a data change.** Inserting `legal_review` between `story` and `script`
  is one node and one edge, reviewed as a diff.
- **Variants are fan-out.** Three `story` nodes with different `with.variant` labels feeding a
  `select_winner` node is an experiment expressed in the graph, using RFC 0002's sibling
  artifacts. No special experiment machinery.

### Node types

| Type | Meaning |
|---|---|
| `transformation` (default) | Run an agent or worker (RFC 0003). The runner does not care which. |
| `human_gate` | Suspend; wait for an external decision; resume. May auto-pass on policy. |
| `fanout` / `select` | Produce N sibling artifacts; choose among them by a declared rule or an agent. |

Conditional edges are permitted only as **declared predicates over artifact fields**
(`confidence.overall >= 0.9`), never as arbitrary code. Anything needing richer logic is a
transformation that emits a decision artifact, which an edge then reads.

### The brain executes the graph; n8n conducts

This is the consequence the previous design left open, and it needs stating plainly rather
than discovering it in implementation.

If the graph is data owned by the brain service, then **the brain walks the DAG** — resolving
ready nodes, checking the artifact cache, dispatching transformations, persisting artifacts,
recording runs. n8n cannot be the executor without the topology leaking back into node wiring,
which is the thing this RFC exists to prevent.

n8n's remaining, real jobs:

- **Scheduling** — cron triggers that `POST /runs`.
- **Human gates** — rendering approval forms and calling back `/runs/{id}/resume`. This is
  genuine value: a review UI we do not have to build.
- **External triggers and notifications** — inbound events, outbound alerts.

n8n therefore holds **no logic**, which satisfies RFC 0001's software-first principle. It is
also honest to record that this makes n8n replaceable: if the human-gate UI is later built into
the brain, n8n's remaining role is cron. That is an acceptable end state, not a failure.

### Resumability and caching

- Run state is derived, not stored as truth: a node is complete iff an artifact exists with
  that node's transformation version over those exact parent ids. Crash recovery is therefore
  re-deriving readiness, not replaying a journal.
- **Cache hit** = an artifact already exists for `(transformation@version, parent ids)`. Workers
  are cached by default (bit-reproducible per RFC 0001). Agents are **not** cached by default —
  re-running is how variants happen — but a run MAY request `reuse: true` to pin an existing
  agent output, which is what "re-render without re-writing the script" means.
- A failed node fails its downstream subtree only. Independent branches continue, then the run
  parks in `blocked` with the failure recorded.

### No runtime planner yet

The executor runs the declared graph. A planner that *emits* a graph document before execution
is compatible with everything here (it produces data the executor then runs, and the emitted
graph is pinned to the run for reproducibility), and is deferred until there is a decision we
cannot express declaratively. Current candidates — "how many research passes does this topic
need?", "loop fact-check until confidence clears threshold" — are better served by a bounded
loop node than by a planner, and that is the next thing to design if it becomes necessary.

## Alternatives Considered

**Hardcoded state machine in the brain (my earlier proposal).** Rejected. Simplest to write,
and it makes every topology change a code change — including the variant/branch futures that
are the point of the Creative layer. Graph-as-data costs almost nothing extra now.

**n8n owns the topology (the current pipeline).** Rejected. The graph would be node wiring:
not diffable in any meaningful way, not pinnable per run, not testable, and it drags logic back
into n8n code-nodes. The predecessor pipeline demonstrates the end state of this.

**Runtime LLM planner (originally proposed).** Deferred. It trades reproducibility — the
property everything else in this series is built to protect — for flexibility with no current
use case. Deliberately kept *additive*: a planner emits a graph, and the executor is unchanged.

**Workflow engine with code-defined DAGs (Temporal, Airflow-style).** Rejected for now. They
solve real problems (durable execution, retries at scale) that we do not yet have at one video
per day, and their DAGs are code, which returns us to the first alternative. Revisit if
durability across restarts becomes painful — the artifact-derived state model above is designed
so that adopting one later does not invalidate the artifact store.

## Consequences

- Topology changes are reviewable diffs; a graph version is a first-class thing to point at
  when explaining why episode 41 differs from episode 12.
- Parallelism is free and implicit from the edges.
- The brain must implement a DAG executor — scheduling, readiness, concurrency limits, failure
  propagation. This is real work (a few hundred lines) that n8n would otherwise have donated.
- n8n's role shrinks to scheduling and human-gate UI. Accepted, and stated openly above.
- Partial re-builds ("re-render only") become natural, which materially reduces the cost of
  iteration — the main practical win over the current pipeline.
- Declared-predicate-only conditionals will occasionally feel restrictive. That is the trade
  for a graph that can be reasoned about statically.

## Migration Strategy

`n8n/long-workflow.json` becomes the first graph document (`longform.v1`), transcribed rather
than reimagined: its Claude stages become agent nodes, its Fal/ElevenLabs/compose stages become
worker nodes, and its poll loop disappears into the `MediaRenderer` adapter (RFC 0004). The n8n
workflow is then reduced to a trigger plus the approval form.

## Open Questions

- Concurrency limits per graph vs per worker: `long-compose` already caps internal scene
  concurrency; the executor also needs a global cap so two runs do not exhaust the 6 GB render
  box. Probably a per-transformation `max_parallel` in the graph document.
- Do human gates need a richer decision than pass/fail — e.g. "approve with edits", which would
  make the human a producer of a corrected artifact rather than a gate? Likely yes eventually;
  it fits RFC 0002 cleanly (a human-authored sibling artifact) and is deferred.
- Loop/iterate node semantics (bounded "fact-check until confidence ≥ X") — needed before the
  Research layer is built, not before the walking skeleton.
