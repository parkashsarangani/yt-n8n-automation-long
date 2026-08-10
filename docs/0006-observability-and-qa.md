# RFC 0006: Observability & QA

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

RFC 0001 rule 4 states that everything is observable, with no opt-out. RFC 0003 requires every
reasoning agent to emit a confidence score. The original specification proposed a single QA
agent whose job was to "reject unsupported claims, weak hooks, pacing issues, or missing
visuals" — four unrelated concerns judged in one pass, returning an unstructured opinion.

The predecessor pipeline logged one row per completed video (topic, token counts, cost, render
time) and nothing per step. When a video came out wrong, there was no record of which stage
went wrong or what it had been told.

## Problem

Two questions, deliberately answered in one RFC because they share a substrate:

1. What is recorded about every transformation, and how do we ask questions of it later?
2. How do we decide an artifact is not good enough to continue, in a way that produces a
   reason rather than a vibe?

## Decision

### Every transformation writes a run record

The runner (RFC 0003) records this for every node execution — agent, worker, and gate alike.
There is no code path that produces an artifact without one.

```jsonc
{
  "run_id":        "run_01J...",
  "graph_id":      "longform.v3",       // pinned graph (RFC 0005)
  "node_id":       "story",
  "transformation":"story_architect", "transformation_version": "3",
  "inputs":        ["sha256:...", "sha256:..."],
  "output":        "sha256:...",        // null on failure
  "status":        "ok | schema_invalid | provider_error | failed | cache_hit | skipped",
  "attempt":       1, "max_attempts": 3,
  "provider":      "anthropic", "model": "claude-opus-4-8",
  "prompt_ref":    "story_architect@4",
  "usage":         { "input_tokens": 18422, "output_tokens": 9310, "cost_usd": 0.325 },
  "confidence":    { "overall": 0.93, "dimensions": { "novelty": 0.74 } },
  "started_at":    "...", "duration_ms": 41230,
  "error":         null                 // message + provider ref when non-ok
}
```

Notes:

- Inputs and outputs are recorded **by artifact id**, never by value — the artifact store holds
  the content, and the log stays queryable.
- `prompt_ref` is pinned, so a later prompt edit never changes the interpretation of a past run.
- Secrets never appear here (RFC 0004).
- Costs roll up per run and per episode by summing `usage.cost_usd`. This generalizes the
  long-form A/B cost logging into the platform, so revenue-per-production-run analysis works
  across every graph without bespoke bookkeeping.

The questions this makes answerable — none of which the predecessor could answer — include:
which stage most often fails validation, what an episode actually cost by stage, whether a
prompt edit changed downstream confidence, and which model produced a specific claim.

### QA is many narrow checks, not one agent

A single QA agent conflates unrelated judgments and returns an opinion. QA is instead a **suite
of independent checks**, each answering one question and each returning a structured verdict.

| Check | Question | Kind |
|---|---|---|
| Editorial | Is the hook strong, the pacing sound, the ending earned? | agent |
| Narrative | Does the story hold together — setup paid off, no contradiction? | agent |
| Legal | Defamation, privacy, regulated-advice, prohibited-topic exposure? | agent |
| Copyright | Are all assets licensed/generated; any recognizable protected material? | agent + worker |
| Brand | Voice, tone, and format consistent with the channel's rules? | agent |
| Technical | Duration, aspect, loudness, caption sync, target requirements met? | **worker** |

Technical QA is a worker — it measures, it does not judge (RFC 0003 rule 1). Note also that
copyright is partly mechanical (does every asset have a provenance record?) and partly
judgment.

### Verdicts are structured

```jsonc
{
  "check": "legal", "verdict": "PASS | WARN | FAIL",
  "reason": "…", "evidence": ["sha256:… #claim-14"],
  "confidence": 0.81, "checked_at": "…"
}
```

The suite emits a single `QAReportArtifact` containing all verdicts — an artifact like any
other (RFC 0002), so it is immutable, addressable, and cited by the publish step.

Gate semantics:

- **Any FAIL** blocks progression. The run parks; the failing verdict and its evidence are the
  message.
- **WARN** does not block; it is surfaced at the next human gate, and warns are counted.
- **PASS** proceeds.
- Thresholds and which checks are blocking are **configuration per graph**, not code — a
  research-heavy documentary and a quick explainer can share checks with different bars.

### Confidence gates, and their honest limits

Low confidence is **not** a retry trigger (RFC 0003). It is a routing signal:

- `confidence.overall < threshold` on a node → route to a human gate rather than auto-proceed.
- A human gate MAY auto-pass above a threshold (RFC 0005 `auto_pass_if`), which is how the
  system earns autonomy incrementally: start with every story reviewed, raise the auto-pass bar
  as confidence proves calibrated.

Stated plainly: **self-reported confidence is not a measurement.** Models are poorly calibrated
and can be confidently wrong. It is used as a *cheap prior for routing attention*, never as
evidence of correctness — that is what QA checks and fact-checking are for. Calibration MUST be
checked empirically: log confidence against downstream QA outcomes and human decisions, and if
the correlation is absent, the thresholds are theatre and should be dropped rather than tuned.

### Three observability surfaces

1. **Run log** (above) — the queryable substrate. Postgres.
2. **Lineage view** — given any artifact, walk `parents` to show what produced it and from what.
   A CLI (`amos why <artifact_id>`) is sufficient at first; the DAG is already in the data.
3. **Cost/quality rollup** — per episode and per graph version: total cost by stage, QA warn
   counts, human interventions, wall-clock. This is the Feedback layer's input, and the direct
   descendant of the A/B run log.

Structured logs and traces MAY be added later; the run log is the durable record and MUST NOT
be replaced by ephemeral logging.

## Alternatives Considered

**One QA agent (the original spec).** Rejected. Conflated concerns produce unactionable
verdicts ("looks okay"), cannot be independently tuned or thresholded, and mean one bad
judgment on pacing can block a legally-fine video with no way to tell which concern fired.

**Log only completed episodes (the current pipeline).** Rejected — it is exactly the data we
found missing when debugging. Per-step is barely more expensive and answers the questions that
actually get asked.

**Emit OpenTelemetry traces as the primary record.** Rejected as primary, fine as an addition.
Traces are optimized for latency debugging with short retention; we need durable, queryable,
joinable-to-artifacts history over months.

**Skip confidence entirely as unreliable.** Tempting and honest, but rejected: a noisy routing
signal is better than none, and the empirical calibration check above means it either earns its
place or gets removed on evidence rather than assumption.

## Consequences

- Every question about a past video is answerable from data, which is most of the value of the
  artifact model realized.
- Writing a run record per node adds a database write per transformation — negligible next to
  a model call or a render.
- Six QA checks cost six agent calls (five, minus the technical worker), which is real money
  per episode. Mitigated by running QA on the timeline once rather than per stage, and by using
  a cheaper capability profile (RFC 0004) for narrow checks.
- Blocking on FAIL means the system stops rather than publishing something wrong. This is the
  intended behaviour and it will sometimes be annoying.
- Confidence thresholds risk becoming superstition if never validated; the calibration check is
  therefore mandatory, not optional.

## Migration Strategy

The existing `/run-log` endpoint in `long-compose` is the ancestor of this design and is
superseded by it: per-episode cost fields become a rollup query over per-node run records. The
existing JSONL file MAY be imported as historical rows or simply left as prior-pipeline data.

## Open Questions

- Retention for run records: cheap enough to keep indefinitely at this volume, so no policy
  until it hurts.
- Should QA checks be able to *fix* rather than only judge (a copyright check that swaps an
  asset)? That would make them producers of corrective artifacts, which RFC 0002 supports.
  Deferred — judge-only is easier to reason about first.
- Which QA checks are worth building before the first published video? Probably Technical only;
  the rest need real failure examples to be written against, and writing them now risks
  specifying against imagined failures.
