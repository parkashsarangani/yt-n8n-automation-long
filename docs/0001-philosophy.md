# RFC 0001: System Philosophy

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

This project began as a YouTube Shorts automation pipeline, was forked into a long-form
pipeline, and is now being generalized. Both predecessors share a shape: an n8n workflow
with logic embedded in code-nodes, a mutable payload passed stage to stage, and outputs
that exist only as files on disk. That shape works for one channel and one format. It does
not survive multiple output targets, multiple model providers, retroactive debugging, or
any question of the form "why did episode 41 say that?"

The long-form pipeline (`n8n/long-workflow.json`, `long-compose/`) is working software and
is not being discarded. It becomes the Production and Distribution tail of the system
described here.

## Problem

Without shared principles, each subsystem makes locally-reasonable choices that globally
conflict: an agent writes a file "just this once", a worker calls a model "because it needed
a judgment call", a stage mutates its input "to save a copy". Each is defensible in isolation
and together they produce a system that cannot be replayed, tested, or reasoned about.

We need a small set of rules that are cheap to state, hard to violate accidentally, and
sufficient to derive most later decisions from.

## Decision

### The system is a compiler

The mental model is **a compiler from ideas into publishable media**, not a workflow engine.
This is load-bearing, not decorative — it means we inherit compiler properties as requirements:

| Compiler concept | This system |
|---|---|
| Source | An intent ("a documentary about the world's strangest airports") |
| Intermediate representation | Immutable, typed, versioned artifacts (RFC 0002) |
| Passes | Transformations: reasoning agents and workers (RFC 0003) |
| Type system | The artifact schema registry (RFC 0007) |
| Diagnostics | QA verdicts — PASS / FAIL / WARN (RFC 0006) |
| Reproducible builds | Re-running a graph over pinned inputs (RFC 0005) |
| Target / backend | Publish targets — YouTube is one (RFC 0004) |

### The five rules

Every component MUST obey these. Everything else in this RFC series derives from them.

1. **Workers never think.** A worker is deterministic code. It MUST NOT be given a model
   provider. If a step needs judgment, it is an agent.
2. **Agents never touch files.** A reasoning agent consumes artifacts and produces artifacts.
   It MUST NOT be given filesystem, database, or network handles. If a step needs I/O, it is
   a worker.
3. **Artifacts are immutable.** No transformation edits its input. Every transformation
   produces a new artifact with recorded parentage.
4. **Everything is observable.** Every transformation records what it consumed, produced,
   cost, and how confident it was — with no opt-out.
5. **Every transformation is reproducible.** Defined precisely below.

### Reasoning Agent, not "LLM Agent"

The term is **reasoning agent**. Today they are backed by a large language model; the
interface MUST NOT assume that. A reasoning agent is anything that maps artifacts to
artifacts by judgment rather than by algorithm — a hosted model, a local model, an ensemble,
a symbolic system, or a human. Naming the interface after today's implementation would bake
that implementation into every call site.

### What "reproducible" means

Reasoning agents are not deterministic and pretending otherwise would be a lie in the
architecture. Reproducibility is therefore defined at two strengths:

- **Workers: bit-reproducible.** Same input artifacts + same worker version ⇒ byte-identical
  output, except where an external encoder (FFmpeg, hardware) introduces nondeterminism we
  do not control. Those exceptions MUST be documented at the worker.
- **Agents: replayable and re-runnable.** The exact recorded output of any past run can be
  replayed from the artifact store forever (strong guarantee). Re-executing the agent over
  the same inputs produces *a* schema-valid output, not the same one (weak guarantee).

Determinism lives at the boundaries — schema validation, QA gates, human checkpoints — not
inside the models. A "deterministic system" here means *any past build can be explained and
replayed exactly*, not *the models are predictable*.

### The six layers

Responsibility boundaries. A component belongs to exactly one layer.

| Layer | Owns | Examples |
|---|---|---|
| **Knowledge** | What the organization knows and can cite | Sources, entities, prior claims, accumulated provenance |
| **Reasoning** | Judgment over knowledge | Research, Fact Check, Story, Script, Visual Plan, QA |
| **Creative** | Concrete creative decisions and their variants | Hooks, titles, thumbnails, narrative structure |
| **Production** | Turning decisions into media | Voice, assets, timeline, render (`long-compose`) |
| **Distribution** | Getting media to an audience | Publish targets — YouTube first, others later |
| **Feedback** | What happened, and what to learn | Analytics, cost accounting, retention, experiment results |

Output targets are plugins of the Distribution layer. YouTube is the first one and MUST NOT
be privileged in any interface above that layer.

### What this is not

It is not an autonomous agent swarm. Topology is declared as data (RFC 0005), not invented
at runtime. Intelligence is applied *within* passes, not to the question of which passes exist.

## Alternatives Considered

**Keep the pipeline framing (stages passing a mutable payload).** Rejected: it is what we
have, and it cannot answer "why did this happen" or "give me that again". Every property we
want — rollback, diffing, provenance, experimentation — is a consequence of immutability,
which the pipeline framing structurally cannot provide.

**Autonomous planner deciding topology per run.** Deferred, not rejected — see RFC 0005. The
production topology is currently known and stable; a runtime planner would trade
reproducibility for flexibility we cannot yet name a use for. The graph is data, so adopting
a planner later is additive.

**Call the deterministic components "services".** Rejected in favour of **workers**. "Service"
suggests a networked thing that might do anything; "worker" carries the constraint (rule 1)
in the name.

**Build the knowledge graph now.** Deferred (RFC 0002 captures the edges regardless). A graph
is a cold-start asset worth approximately nothing at episode 1 and a great deal at episode 400.
Recording provenance from day one makes it materializable later with no rework; building the
reasoning over it now would be designing against imagined data.

## Consequences

- Agents become trivially testable: pure functions from artifacts to artifacts, no mocking of
  filesystems or APIs.
- Workers become trivially testable: no model stubbing, no nondeterminism.
- Storage grows monotonically. Immutability means we never reclaim space by editing; we pay
  in disk to buy provenance. Accepted — media assets dominate the footprint anyway, and a
  retention policy can prune old *blobs* while keeping *lineage* (RFC 0002).
- Some steps become awkward under the rules and that awkwardness is diagnostic: a step that
  wants to both think and write files is two steps.
- Any component above the Distribution layer that mentions "YouTube" is a bug.
- Costs more up front than a script. Justified only because this is a long-lived system; a
  one-off video does not need a compiler.

## Migration Strategy

The existing long-form pipeline is not rewritten. `long-compose` becomes a **worker** behind
the Production layer (it already satisfies rule 1 — it contains no model calls), and the
YouTube upload nodes become the first **publish target**. The n8n workflow's Claude nodes are
superseded by reasoning agents in the brain service; the workflow itself is reduced to
conducting (RFC 0005).

## Open Questions

- Does n8n survive contact with a brain that owns the execution graph, or does it reduce to
  scheduling and human-gate UI only? Deferred to RFC 0005, which makes the call explicitly.
- Is "human as a reasoning agent" worth modelling literally (same interface, different
  backend), or is a human gate a distinct node type? Currently the latter; revisit if the
  distinction starts costing us duplication.
