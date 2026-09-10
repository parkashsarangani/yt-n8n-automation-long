# VidGen — Architecture RFCs

**VidGen** (Autonomous Media Operating System) is a compiler from ideas into publishable media.
YouTube is one output target, not the system.

These RFCs cover the **irreversible** decisions only — the ones that are expensive to change
after artifacts exist. Everything else is deliberately deferred until there is evidence to
design against.

> **Process rule:** architecture for the irreversible, evidence for the reversible.
> An RFC is written when a decision is reached, not in advance of the work that reveals it.

## The five rules (RFC 0001)

1. Workers never think.
2. Agents never touch files.
3. Artifacts are immutable.
4. Everything is observable.
5. Every transformation is reproducible.

## Index

| RFC | Title | Status | What it settles |
|---|---|---|---|
| [0000](0000-template.md) | Template | — | The required shape of every RFC |
| [0001](0001-philosophy.md) | System Philosophy | Accepted | Compiler model, the five rules, six layers, what "reproducible" means |
| [0002](0002-artifact-model.md) | Artifact Model | Accepted | Immutable content-addressed artifacts in a lineage DAG; artifacts over episodes |
| [0003](0003-agent-worker-contract.md) | Agent–Worker Contract | Accepted | Reasoning agents vs workers, structural enforcement, the declarative runner |
| [0004](0004-provider-and-output-abstractions.md) | Provider & Output Abstractions | Accepted | Five vendor interfaces, capability-based selection, publish targets as plugins |
| [0005](0005-execution-graph.md) | Execution Graph | Accepted | Topology as versioned data; the engine executes, n8n conducts |
| [0006](0006-observability-and-qa.md) | Observability & QA | Accepted | Per-transformation run records; QA as six narrow checks with PASS/FAIL/WARN |
| [0007](0007-schema-registry.md) | Artifact Schema Registry | Accepted | One schema per artifact type, versioned; validate on write and read; migrators |

## Deliberately deferred

Not omissions — decisions to make on evidence rather than assumption. Each is designed to be
**additive**, so deferring costs nothing later.

| Deferred | Why | What unblocks it |
|---|---|---|
| Knowledge graph | Worth ~nothing at episode 1, a lot at episode 400. RFC 0002 captures the edges from day one, so it is an indexing job later, not a migration. | Enough episodes for continuity to matter |
| Continuous discovery ingestion (RSS, trends, papers, …) | A whole subsystem with no consumer yet | A regular production cadence |
| Runtime planner | Trades reproducibility for flexibility we cannot yet name a use for. RFC 0005 keeps it additive: a planner emits a graph, the executor is unchanged. | A decision that cannot be expressed declaratively |
| Most QA checks | Should be written against real failures, not imagined ones | First published videos |
| Multi-tenancy, billing, review UI | Personal tool for now | Deciding it is a product |

## Current implementation focus

The production graph is audio-first: editorial selection, narration, moderation,
voice, minimal FFmpeg composition, thumbnail/SEO, technical QA, publishing, and
analytics feedback. The former scene-visual generation and n8n production
implementations are retired.
