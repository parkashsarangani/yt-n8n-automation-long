# brain

The AMOS brain service. Owns artifacts, schemas, agents, workers, and the
execution graph. See [`../docs`](../docs) for the architecture RFCs — they are
the source of truth; this package implements them.

## What exists today

The storage spine (RFC 0002 + RFC 0007). Nothing above it yet.

| Module | RFC | Responsibility |
|---|---|---|
| `src/canonical.ts` | 0007 | RFC 8785 canonical JSON + NFC, and sha256 content hashing |
| `src/artifact.ts` | 0002 | Artifact envelope, content-addressed identity, envelope checks |
| `src/registry.ts` | 0007 | Versioned schema registry; validation; semver ranges; producer allowlist |
| `src/store.ts` | 0002 | `ArtifactStore` interface + immutable filesystem implementation |
| `schemas/` | 0007 | `intent`, `story`, `script`, `visual_plan` at `1.0.0` |

## Invariants under test

- Canonical form is independent of source key order, including the JS
  integer-like-key trap (`Object.keys` gives `["9","10"]`; JCS requires `["10","9"]`).
- NFC-equivalent strings hash identically; NFC-colliding keys throw rather than
  silently dropping one.
- Values that cannot round-trip through JSON throw instead of being coerced.
- An invalid payload never becomes an artifact.
- Identity ignores producer, parents, confidence, and time — the same content
  produced twice dedups to one artifact.
- A tampered artifact file is detected on read.

```bash
npm install
npm test        # 33 tests
npm run typecheck
```

## Deliberate choices worth knowing

**Filesystem store first.** RFC 0002 specifies Postgres + a blob store. The
`ArtifactStore` interface is the contract; `FsArtifactStore` is the
zero-infrastructure implementation for the walking skeleton. A Postgres
implementation slots in behind the same interface when queries (RFC 0006
rollups) need it. The on-disk layout is already content-addressed, so this is a
staging decision, not a divergence.

**Dedup vs. provenance.** Identity is content-only, so the same payload produced
twice is one artifact and the *first* envelope's `parents` are kept. The
authoritative per-production record is the run log (RFC 0006), which captures
every production with its own parents. RFC 0002 asserts both content-addressed
dedup and complete `parents`; where a duplicate makes those conflict, the run
log is the tiebreaker. See the open question in RFC 0002.

## Next

The runner (RFC 0003) and the first two agents (Story, Script), then reuse
`long-compose` for render — the walking skeleton from `../docs/README.md`.
