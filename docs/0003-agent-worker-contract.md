# RFC 0003: Agent–Worker Contract

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

The initial specification listed thirteen "agents": Discovery, Research, Fact Checker, Story
Architect, Script Writer, Visual Planner, Asset Collector, Voice Director, Timeline Composer,
Thumbnail Designer, QA, Publisher, Analytics.

Most of these are not agents. *Asset Collector* calls an image API. *Voice Director* calls a
TTS API. *Timeline Composer* arranges known durations. *Thumbnail Designer* composites an
image. *Publisher* uploads. *Analytics* fetches numbers. None of them require judgment; all of
them are code. Calling them agents invites putting a model where a `for` loop belongs — the
most expensive category error available to us.

## Problem

What exactly is a transformation, what are the two kinds, and how do we stop them bleeding
into each other?

## Decision

### Two kinds of transformation, and the split

Every node in the execution graph is a **transformation**: `artifacts → artifact`.
There are exactly two kinds.

| | **Reasoning Agent** | **Worker** |
|---|---|---|
| Decides by | Judgment (model, ensemble, human) | Algorithm |
| Output for same input | May vary | Byte-identical (RFC 0001) |
| Gets injected | `ModelProvider`, prompt, output schema | Filesystem, blob store, HTTP clients, API creds |
| MUST NOT have | Filesystem / DB / network handles | A `ModelProvider` |
| Emits confidence | Yes, required | No (always 1.0 / omitted) |
| Cost | Tokens | Wall-clock, API units |

Applying the split to the original thirteen:

- **Reasoning agents (7):** Discovery, Research, Fact Checker, Story Architect, Script Writer,
  Visual Planner, QA (which is itself several — RFC 0006).
- **Workers (6):** Asset Collector, Voice Director, Timeline Composer, Thumbnail Designer,
  Publisher, Analytics.

### Enforcement is structural, not documentary

Rules 1 and 2 of RFC 0001 MUST be enforced by construction, because a comment will not hold.

```ts
// A reasoning agent can only reason. There is no file handle in scope.
type AgentContext = { model: ModelProvider; logger: Logger };

// A worker can only act. There is no model in scope.
type WorkerContext = { blobs: BlobStore; http: HttpClient; fs: ScopedFs; logger: Logger };
```

The runner constructs the context; a transformation receives only its own kind. Violating the
rule requires editing the runner, which is a visible, reviewable act — not an accident inside
a 200-line handler.

### Reasoning agents are declarative

An agent is **data plus a prompt**, not a bespoke code path. This is the payoff of the whole
design: seven agents share one implementation.

```jsonc
{
  "name": "story_architect",
  "kind": "agent",
  "consumes": [ { "schema_id": "research", "as": "research" } ],
  "produces": "story",                       // schema id; version resolved by registry
  "prompt":   "story_architect@4",           // prompt store ref — prompts live outside code
  "model":    { "capability": "reasoning_high", "max_output_tokens": 8192 },
  "confidence_dimensions": ["research_completeness", "novelty", "visual_potential", "risk"],
  "retry": { "max_attempts": 3, "on": ["schema_invalid", "provider_error"] }
}
```

The runner does the rest:

```
run(transformation, inputArtifactIds):
  inputs   = artifactStore.load(inputArtifactIds)        # validated on read (RFC 0007)
  if agent:
      prompt = promptStore.get(def.prompt)               # pinned version
      schema = registry.jsonSchema(def.produces)
      out    = model.complete({prompt, inputs, schema})  # structured output, schema-enforced
  else:
      out    = worker.execute(inputs, workerContext)
  validate(out, schema)                                  # on failure → retry with errors
  artifact = envelope(out, parents=inputArtifactIds, producedBy=..., confidence=...)
  artifactStore.put(artifact)                            # content-addressed, immutable
  runLog.record(...)                                     # RFC 0006 — no opt-out
  return artifact.id
```

Adding an eighth agent is a JSON definition and a prompt file. No new control flow.

### Structured output, not brace-repair

Agents MUST request schema-constrained output from the provider where the provider supports
it (`output_config.format` with the registry's JSON Schema). The existing pipeline hand-writes
balanced-brace JSON repair in every parse node; that code MUST NOT be carried forward. Where a
provider lacks structured output, the adapter (RFC 0004) is responsible for emulating it —
never the agent.

### Confidence is part of the contract

Every agent output MUST carry `confidence.overall` in `[0,1]` plus the dimension scores its
definition declares. This is self-assessment, not ground truth — it is calibration-poor by
nature, and RFC 0006 treats it as a *signal for gating*, not a measurement. Agents MUST also
be able to say "I could not do this well": a low-confidence valid output is preferable to a
confident fabrication, and prompts MUST say so.

### Retry semantics

- **Schema-invalid output** → re-run with the validation errors appended to the input. Retries
  MUST differ from the original attempt; an identical retry is a bug (this exact failure was
  observed in the predecessor pipeline).
- **Provider error / rate limit** → exponential backoff, then fail the transformation.
- **Low confidence** → NOT a retry. It is a QA/gate decision (RFC 0006). Retrying until the
  model sounds sure is how you manufacture false confidence.
- Retry budgets are per transformation and recorded in the run log.

### Prompts live outside code

Prompts are versioned files in a prompt store, referenced as `name@version`. A run pins the
version it used (recorded in the run log), so a prompt edit never silently changes the meaning
of past runs. Prompt edits are ordinary reviewable diffs.

## Alternatives Considered

**Everything is an agent (the original spec).** Rejected — it puts a model in the path of
deterministic work, multiplying cost, latency, and failure modes for zero benefit. It is also
the specific anti-pattern this project has already been burned by.

**Everything is code; models are called ad hoc inside it.** Rejected — this is the current
pipeline. It works and it is untestable: business logic ends up inside n8n code-nodes with no
versioning, no schema enforcement, and per-call bespoke parsing.

**Agents may write files for convenience (e.g. save their own output).** Rejected explicitly.
It is the single most tempting violation and it breaks immutability, provenance, and testability
at once. The runner persists; the agent returns.

**A third kind: "hybrid" transformations that both reason and act.** Rejected. Every candidate
example decomposed cleanly into an agent followed by a worker. Allowing the category would make
rules 1 and 2 unenforceable.

## Consequences

- Agents are pure functions of their inputs — unit-testable with fixture artifacts and a stubbed
  provider, no filesystem mocking.
- Workers are testable with no model stubbing and are cacheable by content hash.
- Adding an agent is configuration; adding a worker is code. The asymmetry is intentional —
  reasoning should be cheap to add, side effects should not.
- Some transformations become two nodes where one felt natural (e.g. Visual Planner *decides*
  search terms; Asset Collector *fetches* images). This is more graph nodes and more artifacts
  — accepted, and it is what makes "regenerate the images without re-writing the plan" trivial.
- Confidence must be produced by every agent even when it is poorly calibrated. We accept a
  noisy signal because a missing one cannot be improved.

## Migration Strategy

The long-form pipeline's Claude HTTP nodes map onto agent definitions (Story ≈ blueprint +
act-writer, Visual Planner ≈ the folded-in visual plan). Their prompts move to the prompt store
roughly as-is and are then improved. `long-compose` becomes a worker unchanged — it already has
no model calls. ElevenLabs and Fal calls become Voice and Asset Collector workers behind the
RFC 0004 adapters.

## Open Questions

- Is a human approver modelled as an agent with a "human" provider, or as a distinct gate node?
  Currently a distinct node type (RFC 0005). The unified model is elegant but pretends a human
  has a token budget and a latency SLA.
- Do multi-step agents (agent calls a tool, reasons again) fit rule 2? Tool-using agents need
  *something* like I/O. Current position: tool calls are mediated by the provider adapter and
  restricted to a declared allowlist per agent definition, so the agent still holds no handles.
  Revisit when the Research agent is designed — it is the first real test.
