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
| `src/graph.ts` | 0005 | Graph document + static validation (arity, schema wiring, cycles) |
| `src/predicate.ts` | 0005 | Declared predicates for auto-pass gates — not an expression language |
| `src/executor.ts` | 0005 | Walks the DAG: readiness, bounded concurrency, gates, blocking, progress events |
| `src/service.ts` | — | Assembles the brain for one operator; live run state |
| `src/server.ts` + `ui/` | — | Loopback-only control UI |
| `src/config.ts` | — | `.env` read/write; secrets masked on the way out |
| `src/blobs.ts` | 0002 | Content-addressed byte storage — audio, images, alignment JSON |
| `src/concurrency.ts` | — | Bounded fan-out; nothing runs unbounded |
| `src/workers/voice.ts` | 0003 | script → voice. TTS per scene with prev/next continuity |
| `src/workers/assets.ts` | 0003 | visual_plan → asset_manifest. Three-rung failure ladder |
| `src/workers/render.ts` | 0003 | script+voice+assets → rendered_video. Joins by scene_index |
| `src/providers/elevenlabs.ts` | 0004 | Real TTS adapter (**never run live**) |
| `src/providers/fal.ts` | 0004 | Real image adapter (**never run live**) |
| `src/providers/compose.ts` | 0004 | long-compose renderer: submit + poll (**never run live**) |
| `src/providers/youtube.ts` | 0004 | Publish target — the only file that knows YouTube (**never run live**) |
| `src/workers/publish.ts` | 0003 | rendered_video+story → published_episode, gated on `requirements()` |
| `agents/`, `prompts/` | 0003 | `story_architect`, `script_writer`, `visual_planner` — data, not code |
| `graphs/` | 0005 | `skeleton@5` — two human gates: the story premise, and the narration script |
| `schemas/` | 0007 | `intent`, `story`, `script`, `visual_plan`, `voice`, `asset_manifest`, `rendered_video`, `published_episode`; `story` at `1.1.0` |

```bash
npm install
npm test          # 96 tests, no network
npm run typecheck

# the UI is the easiest way in: set keys, start a run, watch it, approve
npm run ui                # http://127.0.0.1:4321
npm run ui -- --publish   # allow real uploads (still private)

# or set credentials by hand
cp .env.example .env

# live run of the skeleton graph. Every provider without a credential falls
# back to a deterministic fake, so a partial setup still runs end to end.
npm run smoke -- "why Chile is so incredibly long"

# it parks at the approval gate below 0.9 confidence:
npm run smoke -- --approve <run_id>

# actually upload (needs YOUTUBE_ACCESS_TOKEN; always uploads PRIVATE):
npm run smoke -- --publish "why Chile is so incredibly long"
```

| Credential | Provider | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | reasoning agents | **required** |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | voiceover | fake audio |
| `FAL_KEY` | images | fake images |
| `COMPOSE_URL` | video assembly | fake renderer |
| `YOUTUBE_ACCESS_TOKEN` + `--publish` | publishing | dry-run target |

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
- A mis-wired graph fails static validation *before* a token is spent.
- A parked run resumes without re-running completed nodes.
- A failed node blocks only its own subtree; independent branches finish.
- Predicates cannot express arbitrary code.
- Blobs are content-addressed and deduped; a tampered blob is caught on read.
- A scene whose image generation fails twice degrades to a placeholder rather
  than failing the video, and is counted.
- Voice clips carry neighbouring narration so prosody does not reset per scene.
- Render joins three artifacts by `scene_index`, not by array position.
- A long render's external job id reaches the run log *before* the job finishes,
  so a crash leaves a trace instead of silently redoing the work.
- The renderer polls to completion, reports the service's own error verbatim on
  failure, and gives up rather than polling forever.
- Publish validates against the target's own `requirements()` and refuses
  *before* upload — the one irreversible step does not get a silent truncation.
- A refused thumbnail degrades and is recorded; a failed synthetic-media
  disclosure throws, because the video would be live and undisclosed.
- A `story@1.0.0` artifact written before `seo_description` existed still
  publishes, on the newer schema, with no migrator.
- The story gate can auto-pass on confidence; the script gate always asks, and
  sits before any paid media work so a rewrite costs only the script.

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

**4. RFC 0004: the async job question, answered.** The RFC left open whether
`MediaRenderer` should expose submit-and-poll or hide it behind a promise. Both,
in different senses: polling is an implementation detail (the promise resolves
when the video is ready), but the **job identity** is surfaced via `onJob` and
written to the run log immediately. Hiding the job entirely makes a crashed
twenty-minute render both unrecoverable and untraceable; putting polling in the
interface leaks one service's shape into every caller. Attaching to an existing
job on resume is *not* implemented — the id is recorded so it becomes possible.

**5. RFC 0007's minor-bump rule works as written.** `story@1.1.0` adds optional
`seo_description` and `tags`. Existing `story@1.0.0` artifacts stay valid,
consumers declaring `^1` keep working, the registry resolves new writes to
1.1.0, and no migrator was needed — the first real exercise of the compatibility
table rather than a hypothetical.

## Other deliberate choices

**Filesystem store first.** RFC 0002 specifies Postgres. The `ArtifactStore`
interface is the contract; `FsArtifactStore` is the zero-infrastructure
implementation. Postgres slots in behind the same interface when RFC 0006
rollup queries need it. The on-disk layout is already content-addressed.

**Blobs are owned by the envelope, referenced by the payload.** Media bytes live
in the blob store; the artifact payload holds only `blob://sha256:...` URIs, so
artifacts stay small and cheap to hash, while `envelope.blobs[]` lists what the
artifact owns for future retention decisions.

**Confidence rides a wrapper schema.** Confidence belongs to the envelope, not
the payload (it must not affect the hash), but it has to come back from the same
call — so the provider is asked for `{payload, confidence}` and the runner
unwraps. Prompts tell the agent that a low score on thin input is more useful
than false certainty.

## A limitation worth stating plainly

`WorkerContext` provably contains no model — the runner builds it, so smuggling
one in means editing the runner. But that proves nothing about dependencies a
worker closes over at *construction* time (`makeVoiceWorker({...})`). The
injected surface is enforced; construction is convention plus review.

## Not built yet, deliberately

- **`fanout` / `select` nodes.** RFC 0005 specifies them for variant generation;
  the validator rejects them with a pointed error rather than silently skipping.
- **Durable run state.** Completion is derived from the run log, so a crash
  mid-node loses only that node. There is no lease or heartbeat, so two
  executors driving the same run would duplicate work — single-process only.
- **Postgres.** See the store note above.

## Next

**The skeleton is structurally complete** — intent to published episode, with a
human gate in the middle. What remains is not architecture:

1. **First live call.** Four adapters (Anthropic, ElevenLabs, Fal, long-compose,
   YouTube) are written from known-good request shapes and have never touched a
   real API. Expect field-name surprises; that run is the real test.
2. **YouTube OAuth.** `YouTubeTarget` takes an access token. Acquiring and
   refreshing it is deliberately out of scope — token custody belongs with
   whoever operates the deployment.
3. **Then the deferred work** from `../docs/README.md`: Discovery, Research,
   Fact Checking, and the knowledge graph — designed with evidence from real
   episodes rather than assumption.
