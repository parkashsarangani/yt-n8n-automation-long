# RFC 0007: Artifact Schema Registry

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

RFC 0002 makes artifacts the primary object and carries `schema_id` + `schema_version` in every
envelope, but does not say where those schemas live or what enforces them. RFC 0003 requires
agents to produce provider-enforced structured output against a JSON Schema. RFC 0006 stores
artifact ids in run records and expects to interpret them months later.

Every one of those depends on a single answer to "what shape is a `story` artifact?" — and if
that answer lives in three places (the agent's prompt, the consumer's parsing code, the
database), they will drift. The drift is silent: the producer adds a field, the consumer ignores
it, a third component assumes it, and the failure surfaces as a bad video rather than an error.

## Problem

Where do artifact schemas live, how do they change without breaking existing artifacts, and
what enforces them?

## Decision

### One registry, one source of truth

Every artifact type has exactly one registered schema, versioned. The registry is
**code-versioned JSON Schema files** loaded at service boot, with the schema id and version
pinned into every artifact envelope.

```
schemas/
  intent/1.0.0.json
  research/1.0.0.json
  research/1.1.0.json
  story/1.0.0.json
  script/1.0.0.json
  visual_plan/1.0.0.json
  asset_manifest/1.0.0.json
  voice/1.0.0.json
  timeline/1.0.0.json
  rendered_video/1.0.0.json
  qa_report/1.0.0.json
  published_episode/1.0.0.json
```

Registry entry:

```jsonc
{
  "schema_id": "story", "version": "1.0.0",
  "status": "active",                 // draft | active | deprecated | retired
  "json_schema": { /* ... */ },
  "produced_by": ["story_architect"], // which transformations may emit it
  "description": "A narrative structure with hook, acts, payoff, and retention beats."
}
```

The JSON Schema is used for **three things at once**, which is the point: provider-side
structured output (RFC 0004), runner validation on write, and consumer validation on read.
One definition, three enforcement points, no drift.

### Validate on write and on read

- **On write** — the runner validates every output before an artifact is created. An invalid
  output never becomes an artifact; it becomes a retry with the validation errors appended
  (RFC 0003). This means **no invalid artifact can exist in the store**, which is a strong
  enough invariant that consumers can trust structure.
- **On read** — a transformation declares which `schema_id` (and compatible version range) it
  consumes; loading an artifact outside that range fails fast at the boundary, with a clear
  error, rather than producing subtly wrong output from an unexpected shape.

Fail-fast on read matters because artifacts are long-lived: an artifact written under `1.0.0`
may be read years later by code expecting `2.x`.

### Versioning and compatibility rules

Semantic versioning, with meanings specific to schemas:

| Change | Bump | Allowed? |
|---|---|---|
| Add an optional field | minor | Yes — backward compatible |
| Add a required field with a default | minor | Yes |
| Relax a constraint (widen enum, raise max) | minor | Yes |
| Add a required field with no default | **major** | Yes, with a migrator |
| Remove or rename a field | **major** | Yes, with a migrator |
| Tighten a constraint (narrow enum, add pattern) | **major** | Yes, with a migrator |
| Change a field's meaning while keeping its name | **major** | Strongly discouraged — prefer a new field |

Consumers declare compatibility as a range (`story@^1`), so minor additions do not require
touching every consumer, while breaking changes are visible and deliberate.

### Migration is a worker, not a mutation

Artifacts are immutable (RFC 0002), so a schema change **never rewrites existing artifacts**.
A major version bump ships with a **migrator worker**: `story@1.4.0 → story@2.0.0`, deterministic,
producing a *new* artifact whose `parents` is the original. Migration is therefore an ordinary
transformation with full provenance — you can always see that artifact X is a migration of
artifact Y, and the pre-migration form still exists.

Migration is **lazy by default**: old artifacts are migrated when something actually needs to
read them at the new version, not in a batch job. A backfill MAY be run, but is never required
for correctness.

### Canonicalization is part of the registry's job

RFC 0002 hashes artifacts by content, so the canonical serialization MUST be fixed before the
first artifact is written or ids are unstable. The registry owns this: **RFC 8785 (JSON
Canonicalization Scheme)** — deterministic key ordering, UTF-8 NFC, fixed number formatting.
The hash covers `canonical(payload) + schema_id + schema_version`. This closes the open question
left in RFC 0002.

### Prompts reference schemas, never restate them

An agent prompt MUST NOT contain a hand-written copy of its output shape. The runner injects
the registry's JSON Schema as the structured-output constraint (RFC 0003/0004). A prompt that
describes its own JSON shape in prose is the drift vector this RFC exists to eliminate — the
predecessor pipeline had exactly this, with the shape spelled out inside a prompt string and
independently parsed downstream.

## Alternatives Considered

**TypeScript types as the source of truth, with JSON Schema generated from them.** Genuinely
attractive — single definition, compile-time safety, good DX. Rejected as *the* source because
the schema must be data at runtime (sent to providers, used to validate stored artifacts,
inspected by tooling), must be versioned independently of a deployment, and must remain readable
by non-TypeScript components. Generating TS *types from* the JSON Schema gives the same DX with
the right primary source, and is the recommended implementation.

**Schemas embedded in agent definitions.** Rejected. Two agents may produce the same artifact
type (a variant writer, a migrator, a human correction), and consumers need the schema without
knowing the producer. The type belongs to the artifact, not the producer.

**No registry; validate ad hoc where it matters.** Rejected — this is the predecessor pipeline,
where shapes lived in prompts and were re-parsed defensively at each consumer. It is precisely
the "hard to change later" failure: by the time drift is visible, hundreds of artifacts exist in
inconsistent shapes with no record of which is which.

**A network schema-registry service (Confluent-style).** Rejected as overkill for a
single-service, single-tenant system. Files in the repo, loaded at boot, give versioning through
git with none of the operational surface. Revisit only if schemas must be shared across
independently deployed services.

## Consequences

- No invalid artifact can exist in the store — a strong, cheap invariant that every consumer
  benefits from.
- Schema changes become explicit, reviewable diffs with a compatibility decision attached.
- Adding an artifact type is a file plus a registry entry, not a database migration (RFC 0002's
  JSONB payload is what makes this true).
- Major bumps carry real cost: a migrator worker must be written and tested. This is the
  intended friction — it makes breaking changes deliberate rather than casual.
- Lazy migration means a read can trigger work, so a first read after a major bump is slower.
  Acceptable; a backfill is available when it is not.
- Canonicalization must be exactly right and is easy to get subtly wrong (float formatting,
  unicode). It needs its own property tests before the first artifact is written.

## Migration Strategy

Not applicable — the registry exists before the first artifact. The initial schemas are derived
from the long-form pipeline's implicit shapes (its blueprint/act/visual-plan JSON) as `1.0.0`
drafts, then tightened once the walking skeleton has produced real examples.

## Open Questions

- How strict should `1.0.0` schemas be at the start? Loose schemas admit sloppy artifacts; strict
  ones cause spurious retries before the prompts are tuned. Proposal: start permissive on
  free-text fields, strict on structure (required keys, types, enums), and tighten after the
  first ten episodes of real data.
- Do we need a `draft` status distinct from `active` for schemas still being shaped during the
  skeleton build? Probably yes for the first month; draft schemas skip the major-bump migrator
  requirement, on the understanding that draft artifacts may be discarded.
- Should the registry also version *prompt* contracts (which schema a prompt is written
  against), or is `prompt_ref` + `schema_version` in the run log enough to reconstruct? Currently
  the latter.
