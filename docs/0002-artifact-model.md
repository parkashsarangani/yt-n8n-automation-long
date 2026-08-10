# RFC 0002: Artifact Model

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** the mutable "Canonical Content Object" from the initial specification

## Context

The original specification proposed a single JSON document (`{idea, research, story,
chapters, visuals, assets, voiceover, timeline, metadata}`) that each stage fills in as the
episode progresses, alongside nine normalized database tables. These two models describe the
same data twice and will drift.

More importantly, the mutable-document model destroys information: once the Script agent has
run, the state that produced it is gone. "Why did episode 41 claim that?" and "give me the
version before the QA rewrite" are both unanswerable.

## Problem

What is the unit of state in this system, and what guarantees does it carry?

## Decision

### Artifacts are the primary object; episodes are not

The system is modelled as **a DAG of immutable artifacts connected by transformations**. There
is no privileged "episode" aggregate that owns the others. An *episode* is simply the artifact
type that happens to be publishable — the terminal node of one path through the graph, no more
structurally special than a `StoryArtifact`.

```
IntentArtifact
   └─▶ ResearchArtifact ──▶ StoryArtifact ──▶ ScriptArtifact ──▶ VisualPlanArtifact
                                                    │                    │
                                                    ▼                    ▼
                                              VoiceArtifact        AssetManifestArtifact
                                                    └────────┬───────────┘
                                                             ▼
                                                      TimelineArtifact
                                                             ▼
                                                   RenderedVideoArtifact
                                                             ▼
                                                  PublishedEpisodeArtifact
```

Every edge is a transformation. Nothing above is a container for anything else.

### Artifact envelope

Every artifact MUST carry this envelope. The `payload` is typed by the schema registry
(RFC 0007); the envelope is universal.

```jsonc
{
  "artifact_id":     "sha256:...",        // content hash of canonical(payload) + schema id/version
  "schema_id":       "story",             // registry key
  "schema_version":  "1.2.0",
  "produced_by": {
    "transformation": "story_architect",  // agent or worker name
    "version":        "3",                // transformation version (see Reproducibility)
    "run_id":         "run_01J...",       // links to the run record (RFC 0006)
    "provider":       "anthropic/claude-opus-4-8"  // null for workers
  },
  "parents":         ["sha256:...", "sha256:..."],  // input artifact ids, ordered
  "confidence":      { "overall": 0.93, "dimensions": { "research_completeness": 0.88 } },
  "created_at":      "2026-08-10T09:12:44Z",
  "labels":          { "lineage_id": "lin_01J...", "variant": "a" },
  "payload":         { /* schema-typed */ },
  "blobs":           [ { "role": "video", "uri": "blob://sha256:...", "bytes": 214_000_000 } ]
}
```

Rules:

- `artifact_id` MUST be the content hash. Two identical payloads produced twice are the same
  artifact — dedup is free and equality is meaningful.
- `parents` MUST list every artifact the transformation actually consumed. This is the
  provenance edge set, and it is not optional.
- Artifacts MUST NOT be updated or deleted in place. Corrections are new artifacts.
- Large binary payloads (video, audio, images) MUST live in the blob store, referenced by
  hash. The artifact record itself stays small and queryable.

### Versioning is lineage, not a counter

"Version 2 of the story" is not a mutation of version 1 — it is **a sibling artifact with the
same `lineage_id` and a later `created_at`**, produced either by re-running a transformation
or by a correction pass. The `lineage_id` groups them; the `parents` edges explain them.

This gives, with no extra machinery:

- **Rollback** — point the run at an earlier artifact id.
- **Diffing** — two artifacts of the same schema, structurally compared.
- **Experimentation** — three `StoryArtifact`s with `labels.variant = a|b|c` sharing a parent
  are an A/B/C test, and the graph can fan out to them (RFC 0005) without any special "variant"
  concept.
- **Provenance** — walk `parents` transitively to the source claims.
- **Debugging** — every past state still exists.

### Storage

- **Postgres** — one `artifacts` table (envelope columns + `payload JSONB`), one `edges`
  projection (`child_id`, `parent_id`, `role`) for cheap graph queries, plus the run records
  from RFC 0006. Content-addressed ids make the primary key natural.
- **Blob store** — content-addressed files. Local filesystem to start (`blob://sha256:...`
  resolving under a data volume); S3-compatible later with no schema change.

The nine tables from the original specification (`ideas`, `episodes`, `sources`, `assets`,
`prompts`, `agent_runs`, `qa_reports`, `publications`, `analytics`) mostly become **views or
narrow projections over artifacts** rather than independent tables. `sources`, `assets`,
`qa_reports`, and `publications` are artifact types. `agent_runs` is the run log (RFC 0006).
`prompts` belongs to the prompt store (RFC 0003). Only genuinely external, mutable data —
`analytics` counters pulled from YouTube — warrants its own mutable table.

### The knowledge graph is captured now, built later

Per RFC 0001, we are not building graph reasoning yet. But the edges it would need are exactly
the edges immutability already forces us to record:

- `(claim) → (source)` inside `ResearchArtifact` payloads
- `(artifact) → (parent artifact)` in the envelope
- `(episode) → (entity)` via an `entities` field on research/story payloads

Because these are captured from day one, materializing a knowledge graph later is an
indexing job over existing data, not a migration. **Capture the edges; defer the brain.**

### Retention

Immutability is about the *record*, not the *bytes*. A retention policy MAY prune blob
contents (a 200 MB intermediate render from six months ago) while keeping the artifact
envelope, hash, and lineage intact. A pruned blob MUST be marked, not silently missing, so
that replay fails loudly rather than producing a different video.

## Alternatives Considered

**Mutable content object (the original spec, and my earlier proposal).** Rejected. Simpler to
write, but it cannot answer provenance or rollback questions, and every later feature we want
— variants, diffing, experiment tracking, the knowledge graph — has to be bolted on as a
parallel mechanism.

**Event sourcing (append-only event log, state as a fold).** Rejected as the primary model.
It gives the same audit properties, but the natural unit here is a *document produced by a
pass*, not a stream of fine-grained mutations. Artifacts-as-DAG is the closer fit and is far
easier to reason about when a "state" is a 3,000-word script.

**Git as the store.** Genuinely tempting — it is content-addressed, immutable, and diffable
by construction. Rejected because the query patterns we need ("all artifacts citing source X",
"all runs where confidence < 0.8") are database questions, and because large binary blobs are
git's known weakness. We adopt git's *model*, not git.

**Normalized tables per artifact type.** Rejected: schemas evolve (RFC 0007) and a migration
per schema change is exactly the drift tax we are trying to avoid. JSONB payload + registry
validation gives evolution without DDL churn.

## Consequences

- Storage grows monotonically; disk is the price of provenance. Mitigated by blob retention.
- Every transformation must be explicit about its inputs — no ambient access to "the episode".
  This is a real ergonomic cost and a real correctness win.
- Equality and dedup are free (content addressing). Re-running an unchanged worker over
  unchanged inputs is a cache hit, which makes partial re-builds cheap.
- Experimentation needs no new concept — it is fan-out in the graph plus a `variant` label.
- Debugging a bad video means walking a DAG, which needs tooling (a lineage viewer) that a
  mutable model would not have needed. Accepted; the CLI version is trivial.

## Migration Strategy

Nothing to migrate — no artifacts exist yet. The existing long-form pipeline's outputs are
files on disk with no envelope; they are not imported. The first artifact is created by the
walking skeleton.

## Open Questions

- Canonical JSON form for hashing: key ordering, unicode normalization, float representation.
  Must be pinned before the first artifact is written, or ids are unstable. Proposal: RFC 8785
  (JCS). To be settled in implementation of RFC 0007.
- Do blobs get their own retention/GC policy per artifact type, or one global policy? Defer
  until storage actually hurts.
- Should `confidence` be part of the hashed payload or the envelope only? Currently envelope,
  so that re-scoring confidence does not change an artifact's identity. Revisit if confidence
  starts driving downstream behaviour in ways that need to be pinned.
