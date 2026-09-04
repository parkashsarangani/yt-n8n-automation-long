# Shared FreeLLMAPI routing

The Long pipeline uses the same FreeLLMAPI instance already deployed by the
Shorts repository on this server. It does **not** deploy another FreeLLMAPI
container, database volume, or copy of the Shorts `llm-gateway`.

## Runtime architecture

```text
reasoning + vision QA -------------------+
                                         |
experimental image generation -----------+--> shared freellmapi:3001
                                         |
experimental narration ------------------+

reasoning failure (when enabled) ------------> direct paid OpenAI
IMAGE_PROVIDER_MODE=fal ---------------------> Fal FLUX.2 + edit
SPEECH_PROVIDER_MODE=elevenlabs -------------> ElevenLabs
```

`yt-n8n-automation-shorts` remains the infrastructure owner: pinned FreeLLMAPI
container, encrypted provider state and Docker network. Long owns only its
application routing policy and direct-provider rollback credentials.

## Activation

Use the same unified `FREELLMAPI_API_KEY` as Shorts. Long production attaches the
engine container to `yt-n8n-automation-shorts_default` and checks the internal
FreeLLMAPI endpoint from inside that container.

For reasoning-only FreeLLMAPI routing, an unavailable shared route can remain a
warning because paid OpenAI fail-open exists. If either experimental media mode
uses FreeLLMAPI, deployment treats a missing key/network/unreachable shared
service as fatal: media has deliberately **no per-shot paid fail-open**, because
mixing image generators or narrator voices inside one episode would create
visible/audible discontinuity.

## Reasoning / vision controls

```text
LLM_ROUTER_MODE=freellmapi
LLM_ROUTER_FAIL_OPEN_TO_DIRECT=true
FREELLMAPI_BASE_URL=http://freellmapi:3001/v1
FREELLMAPI_TEXT_MODEL=auto:smart
FREELLMAPI_VISION_MODEL=auto:smart
LLM_ROUTER_TIMEOUT_MS=120000
```

`LLM_ROUTER_MODE=direct` is the immediate reasoning/vision rollback to Long's
existing paid OpenAI configuration.

## Experimental media controls

Production currently opts into:

```text
IMAGE_PROVIDER_MODE=freellmapi
SPEECH_PROVIDER_MODE=freellmapi
FREELLMAPI_IMAGE_MODEL=flux
FREELLMAPI_SPEECH_MODEL=openai-audio
FREELLMAPI_SPEECH_VOICE=onyx
FREELLMAPI_SPEECH_FORMAT=mp3
FREELLMAPI_MEDIA_TIMEOUT_MS=120000
```

These are config choices, not graph changes.

### Images

`FREELLMAPI_IMAGE_MODEL=flux` is pinned rather than `auto` so one episode does not
wander across image models/providers. On FreeLLMAPI v0.9.5 this resolves to the
Pollinations image adapter and honors the requested aspect dimensions.

The limitation is explicit: FreeLLMAPI's OpenAI-style `/v1/images/generations`
endpoint is text-to-image. It does not carry Fal's reference-conditioned
`flux-2/edit` contract. The existing illustrated asset worker therefore keeps
its shot-pack contract but each FreeLLM image is generated independently. The
existing visual QA and pre-render release gates remain unchanged and are expected
to expose any continuity/style regression.

Rollback only images:

```text
IMAGE_PROVIDER_MODE=fal
```

Fal then resumes the existing FLUX.2 + FLUX.2/edit path with canonical reference
conditioning across recurring subjects and shot packs.

### Narration

`FREELLMAPI_SPEECH_MODEL=openai-audio` is pinned rather than `auto` so narrator
identity cannot switch after a provider failure. The experiment uses the
OpenAI-style `onyx` voice and MP3 output, which fits the current render contract
without introducing a WAV/transcoding migration.

FreeLLM speech does not provide ElevenLabs character alignment or the
`previous_text` / `next_text` prosody-continuity fields. This experiment therefore
tests whether simple voiceover quality is sufficient for the channel. Existing
rendering still works because alignment is optional; any caption/timing quality
difference must be evaluated on the comparison episode.

Rollback only narration:

```text
SPEECH_PROVIDER_MODE=elevenlabs
```

That restores the existing ElevenLabs `/with-timestamps` path and contextual
prosody fields.

## Deployment verification

When a FreeLLM media mode is selected, deployment performs tiny smoke calls
against the exact configured `/v1/images/generations` and `/v1/audio/speech`
endpoints before reporting success. It also requires both image and speech
capabilities to report `real=true` from `/api/config`.

The smoke calls intentionally do not log the unified key or generated media.

## Provider attribution and cost

Reasoning artifacts still record the route that answered. FreeLLM image/speech
providers likewise report `provider: freellmapi` and `cost_usd: 0`; the selected
upstream/model is retained where the media API exposes it. Fal and ElevenLabs
retain their existing paid cost accounting when rollback modes are selected.

## Lifecycle caveat

The shared Docker network is owned by the Shorts Compose project. If that network
is removed/recreated, redeploy Long after Shorts is healthy. With FreeLLM media
selected, Long intentionally refuses to report a healthy deployment until the
shared route is reachable; with Fal/ElevenLabs selected, only reasoning/vision
uses that route and paid OpenAI fail-open can keep the pipeline operational.
