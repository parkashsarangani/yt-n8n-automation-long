# brain

The AMOS brain service. Owns artifacts, schemas, agents, workers, and (later)
the execution graph. See [`../docs`](../docs) for the architecture RFCs — they
are the source of truth; this package implements them.

## What exists today

The storage spine and the transformation runner. No graph executor yet.

| Module | RFC | Responsibility |
|---|---|---|
| `src/canonical.ts` | 0007 | RFC 8785 canonical JSON + NFC, sha256 content hashing |
| `src/artifact.ts` | 0002 | Artifact envelope, content-addressed identity, envelope checks |
| `src/registry.ts` | 0007 | Versioned schemas; validation; semver ranges; producer allowlist |
| `src/store.ts` | 0002 | `ArtifactStore` interface + immutable filesystem implementation |
| `src/prompts.ts` | 0003 | Versioned prompt store, `name@version`, strict `{{var}}` rendering |
| `src/provider.ts` | 0004 | `ModelProvider` interface, capability routing, schema relaxation |
| `src/providers/anthropic.ts` | 0004 | The only file that knows Anthropic exists. Owns the price table |
| `src/providers/fake.ts` | 0004 | Deterministic provider for tests — zero network, zero cost |
| `src/runner.ts` | 0003 | One harness for every transformation; validate-and-retry |
| `src/catalog.ts` | 0003 | Loads agents from disk; cross-checks them at boot |
| `agents/`, `prompts/` | 0003 | `story_architect`, `script_writer` — data, not code |
| `schemas/` | 0007 | `intent`, `story`, `script`, `visual_plan` at `1.0.0` |

```bash
npm install
npm test          # 45 tests, no network
npm run typecheck

# live end-to-end (intent -> story -> script) against a real model:
ANTHROPIC_API_KEY=sk-ant-... npm run smoke -- "why Chile is so incredibly long"
```

## Invariants under test

- Canonical form is independent of source key order, including the JS
  integer-like-key trap (`Object.keys` gives `["9","10"]`; JCS needs `["10","9"]`).
- NFC-equivalent strings hash identically; NFC-colliding keys throw.
- Values that cannot round-trip through JSON throw instead of being coerced.
- An invalid payload never becomes an artifact — even after retries are exhausted.
- Identity ignores producer, parents, confidence, and time.
- A tampered artifact file is detected on read.
- **Two different agents run through one harness with no agent-specific code.**
- A retry differs from the attempt that failed (the validation errors are fed back).
- A refusal is not retried.
- Workers receive a context with no model in it.
- Inputs are validated on read *before* a token is spent.

## What implementation revealed about the RFCs

Three things the specs did not settle. Each is worth folding back.

**1. RFC 0002: dedup and complete `parents` can conflict.** Identity is
content-only, so the same payload produced twice is one artifact and the *first*
envelope's `parents` are kept. The run log (RFC 0006) is the authoritative
per-production record. Resolved in favour of the compiler model: the node is
content-addressed, the edge belongs to the production event.

**2. RFC 0007: the producer allowlist conflicts with the migration story.** The
allowlist says only `script_writer` may produce a `script`, but RFC 0007 also
specifies migrators as workers that produce `story@2.0.0` from `story@1.4.0` —
which the allowlist forbids. A test caught this. Currently the allowlist wins
and every legitimate producer must be listed explicitly; the migration design
needs either an exemption for migrators or a naming convention.

**3. RFC 0004: structured outputs cannot express our schemas.** Length, range,
and item-count constraints are rejected by the structured-output API, and our
schemas use all three. The provider therefore receives a *relaxed projection*
(`relaxForStructuredOutput`) while the registry schema stays the strict
validator on write — with stripped constraints appended to each field's
`description` so the model still sees them as instruction. The practical effect
is that some constraints are enforced by validate-and-retry rather than by the
output grammar, which makes the retry loop load-bearing rather than defensive.

## Other deliberate choices

**Filesystem store first.** RFC 0002 specifies Postgres. The `ArtifactStore`
interface is the contract; `FsArtifactStore` is the zero-infrastructure
implementation. Postgres slots in behind the same interface when RFC 0006
rollup queries need it. The on-disk layout is already content-addressed.

**Confidence rides a wrapper schema.** Confidence belongs to the envelope, not
the payload (it must not affect the hash), but it has to come back from the same
call — so the provider is asked for `{payload, confidence}` and the runner
unwraps. Prompts tell the agent that a low score on thin input is more useful
than false certainty.

## Next

The execution graph (RFC 0005) — topology as versioned data, with the brain
walking the DAG. Then the visual-plan agent and the `long-compose` render
worker, which completes the walking skeleton.
