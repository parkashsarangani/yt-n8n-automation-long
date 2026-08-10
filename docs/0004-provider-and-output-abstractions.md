# RFC 0004: Provider & Output Abstractions

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

The original specification requires "provider-agnostic AI models" and records the decision
that "AI providers are swappable". The predecessor pipelines do the opposite: Anthropic,
ElevenLabs, Fal, and YouTube endpoints are hardcoded into n8n HTTP nodes, with request bodies,
auth headers, and response shapes spread across the workflow.

RFC 0001 additionally requires that YouTube be one output plugin among many, not a privileged
destination.

## Problem

Where does vendor knowledge live, and what exactly is the interface that keeps it there?

## Decision

### Five interfaces

Vendor-specific code lives behind exactly these, and nowhere else.

```ts
interface ModelProvider {           // reasoning agents (RFC 0003)
  complete(req: {
    prompt: RenderedPrompt;
    inputs: Artifact[];
    outputSchema: JSONSchema;       // structured output is the contract, not a hint
    maxOutputTokens?: number;
    tools?: ToolAllowlist;
  }): Promise<{ payload: unknown; usage: Usage; providerRef: string }>;
  capabilities(): ProviderCapabilities;
}

interface SpeechProvider {          // Voice worker
  synthesize(req: { text: string; voice: VoiceRef; context?: { prev?: string; next?: string } })
    : Promise<{ audio: Blob; alignment?: WordAlignment; usage: Usage }>;
}

interface ImageProvider {           // Asset Collector worker
  generate(req: { prompt: string; aspect: Aspect; count?: number })
    : Promise<{ images: Blob[]; usage: Usage }>;
}

interface MediaRenderer {           // Render worker
  render(timeline: TimelineArtifact): Promise<{ video: Blob; thumbnail?: Blob; stats: RenderStats }>;
}

interface PublishTarget {           // Distribution layer plugin
  id: string;                       // "youtube", "tiktok", "podcast", "blog"
  requirements(): TargetRequirements;   // aspect, max duration, metadata fields, disclosure rules
  publish(req: { media: Blob; thumbnail?: Blob; metadata: TargetMetadata })
    : Promise<{ externalId: string; url: string }>;
  fetchMetrics(externalId: string, window: DateRange): Promise<MetricSet>;
}
```

### Selection is by capability, not by name

Agent definitions MUST NOT name a vendor or model id. They declare what they need:

```jsonc
"model": { "capability": "reasoning_high", "max_output_tokens": 8192 }
```

A capability profile (config, not code) maps `reasoning_high` → a concrete provider+model, with
a fallback chain. Swapping the whole system to a different vendor is a config edit; running one
agent on a cheaper model to measure quality/cost trade-off is a one-line change. The resolved
concrete model is recorded on the artifact (`produced_by.provider`) so past runs remain
explicable after the mapping changes.

Profiles to start with: `reasoning_high` (story, script, fact-check), `reasoning_fast`
(classification, scoring, short structured extraction), `reasoning_max` (reserved — hard
research synthesis).

### Capability declaration and emulation

`ProviderCapabilities` MUST declare at minimum: structured-output support, max context, max
output tokens, tool-use support, and per-token cost. The runner uses this to decide what it can
rely on. Where a provider lacks structured output, **the adapter emulates it** (constrained
prompting + validate + repair loop) and reports `structuredOutput: "emulated"`. Agents never
know the difference — RFC 0003 forbids them handling it.

### Cost accounting happens at the adapter boundary

Every provider call MUST return a normalized `Usage`:

```jsonc
{ "input_tokens": 18422, "output_tokens": 9310, "units": null, "cost_usd": 0.325,
  "provider": "anthropic", "model": "claude-opus-4-8" }
```

Non-token providers report `units` (characters for TTS, images generated, render seconds). The
adapter owns the price table; the runner just records what it is told (RFC 0006). This is the
generalization of the per-run cost logging built for the long-form A/B, and it is the only place
prices are written down.

### Output targets are plugins

`PublishTarget` is a plugin interface, and the Production layer is target-aware only through
`requirements()`. A target declares its constraints (aspect ratio, duration ceiling, metadata
fields, synthetic-media disclosure); the timeline/render workers read the declaration. Nothing
above the Distribution layer may branch on `target.id === "youtube"`.

YouTube is the first implementation, carried over from the existing pipeline: upload,
`containsSyntheticMedia` disclosure, `thumbnails.set` (which requires a phone-verified channel
— a target-specific precondition that belongs in `requirements()`, not in a workflow comment).

### Credentials

Credentials belong to adapters, resolved from the environment at construction. Neither agents,
workers, nor artifacts ever carry a secret. No credential may appear in an artifact payload,
prompt, or run log — the run log records *which* credential profile was used, never its value.

## Alternatives Considered

**Use a cross-vendor abstraction library (LangChain-style) as the interface.** Rejected. We
need five narrow interfaces we fully control; adopting a large abstraction means inheriting its
model of the world and its churn, to solve a problem that is roughly 200 lines of adapter code.

**Let agent definitions name concrete models.** Rejected — it makes the swappability decision a
find-and-replace across every definition, and it means a model deprecation is a code change in
N places. Capability profiles put it in one.

**Skip the abstraction until a second provider is actually needed (YAGNI).** Rejected here,
though it is normally sound. The interfaces cost little now and are the definition of an
irreversible decision: retrofitting them means touching every call site. RFC 0001's rule —
architecture for the irreversible, evidence for the reversible — puts this on the architecture
side. Note the contrast with the knowledge graph, which is deliberately deferred *because* it
is additive later.

**Treat publishing as just another worker, with no target interface.** Rejected — it collapses
the Distribution layer and re-privileges YouTube. Multi-target ("this documentary becomes a
YouTube video, a podcast episode, and a blog post from the same script artifact") is the payoff
the layered model exists for.

## Consequences

- Every vendor call is mockable at one seam; the whole system is testable with zero network.
- Cost and token accounting are automatic and uniform rather than per-node bookkeeping.
- Model migration (e.g. a new Claude generation) is a profile edit plus an eval run, not a
  refactor.
- We pay a small translation tax per provider and cannot use vendor-specific features that do
  not fit the interface, unless we widen it deliberately.
- Emulated structured output on weaker providers will be less reliable than native. The adapter
  reports which mode was used so quality differences are attributable rather than mysterious.

## Migration Strategy

Adapters are written by lifting the existing pipeline's request bodies: the Anthropic HTTP node
becomes the Anthropic `ModelProvider`, ElevenLabs `/with-timestamps` (including
`previous_text`/`next_text` continuity) becomes the `SpeechProvider`, Fal `flux/dev` becomes the
`ImageProvider`, `long-compose`'s `/compose` + polling becomes the `MediaRenderer`, and the
YouTube upload + disclosure + thumbnail nodes become the first `PublishTarget`.

## Open Questions

- Does `MediaRenderer` stay async-job-shaped (submit + poll, as `long-compose` is today) in the
  interface, or is polling an implementation detail hidden behind a promise? Leaning hidden, with
  progress events — but long renders plus process restarts may force it into the interface.
- Where do per-target metadata differences live — one `TargetMetadata` union, or target-specific
  metadata artifacts produced by a metadata agent per target? Defer until the second target exists.
- Local/self-hosted models: same interface, but latency and context limits differ enough that
  capability profiles may need cost/latency budgets, not just capability names.
