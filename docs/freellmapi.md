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

The portable FreeLLM media configuration is:

```text
IMAGE_PROVIDER_MODE=freellmapi
SPEECH_PROVIDER_MODE=freellmapi
FREELLMAPI_IMAGE_MODEL=auto
FREELLMAPI_SPEECH_MODEL=auto
FREELLMAPI_SPEECH_VOICE=onyx
FREELLMAPI_SPEECH_FORMAT=mp3
FREELLMAPI_MEDIA_TIMEOUT_MS=120000
```

The media-model registry is separate from `/v1/models`. Do not copy a chat model
id into the image or audio endpoints and do not guess a provider-native id.
`auto` means "use the enabled rows for this media modality" and is therefore the
only portable default across FreeLLMAPI catalog revisions/installations.

### Images

FreeLLMAPI v0.9.5 treats Pollinations as keyless-capable for image generation.
That means a Pollinations image row needs no provider credential, but the row
still has to exist and be enabled in FreeLLMAPI's separate media registry.

Long deliberately does **not** read or mutate `/api/media`: FreeLLMAPI protects
that dashboard/admin surface with a dashboard session token, while
`FREELLMAPI_API_KEY` authorizes only `/v1` inference. The Shorts-owned FreeLLM
instance therefore keeps ownership of its media configuration.

When `IMAGE_PROVIDER_MODE=freellmapi`, deployment smoke-tests
`/v1/images/generations` with `model=auto`. If FreeLLM answers that no usable image
provider is enabled, deployment fails with an explicit instruction to open the
shared FreeLLMAPI dashboard, go to **Models → Image**, enable a Pollinations image
row, and redeploy. No API credential is required for that Pollinations row on
v0.9.5.

The architectural limitation remains explicit: FreeLLMAPI's OpenAI-style image
surface is text-to-image. It does not carry Fal's reference-conditioned
`flux-2/edit` contract. Each FreeLLM image is therefore generated independently.
Existing image text/semantic QA, hero ranking, episode sequence review and
`visual_asset_release` remain authoritative and should reject unacceptable
continuity/style regressions.

Rollback only images:

```text
IMAGE_PROVIDER_MODE=fal
```

Fal then resumes the existing FLUX.2 + FLUX.2/edit path with canonical reference
conditioning across recurring subjects and shot packs.

### Narration

The live shared instance has proven that `FREELLMAPI_SPEECH_MODEL=auto` can route
to Google TTS. Google/Gemini returns WAV even when the request expresses an MP3
preference; FreeLLMAPI v0.9.5 intentionally wraps Gemini's PCM output as WAV.
Accordingly `FREELLMAPI_SPEECH_FORMAT=mp3` is a preference, not an assertion
about the bytes that come back.

Long now preserves the real speech media type end to end:

1. `FreeLLMSpeechProvider` accepts supported audio response types and returns the
   actual `media_type` (including `audio/wav`).
2. The voice artifact stores `media_type` per clip.
3. The render worker forwards that type rather than hardcoding `audio/mpeg`.
4. `ComposeRenderer` sends it to long-compose. Long-compose hands the inline
   bytes to FFmpeg, whose input probing accepts WAV natively even through the
   legacy `voice_N.mp3` temporary filename; this behavior has a regression test.

FreeLLM speech still does not provide ElevenLabs character alignment or the
`previous_text` / `next_text` prosody-continuity fields. This experiment therefore
tests whether simple voiceover quality is sufficient for the channel. Alignment
is optional in the renderer, so lack of ElevenLabs timing data is a quality
comparison question rather than a media-format failure.

Rollback only narration:

```text
SPEECH_PROVIDER_MODE=elevenlabs
```

That restores the existing ElevenLabs `/with-timestamps` path and contextual
prosody fields.

## Deployment verification

When FreeLLM media is selected, deployment validates the real shared instance
rather than trusting static configuration:

- reach `freellmapi:3001` from inside the Long engine container;
- smoke-test `/v1/images/generations` with `model=auto` without attempting an
  admin-session bypass;
- give the exact dashboard action if no usable image row is enabled;
- smoke-test `/v1/audio/speech` with `model=auto` and accept/log the actual audio
  content type returned by the provider;
- require both selected media capabilities to report `real=true` from
  `/api/config`.

The smoke calls do not log the unified key or generated media.

## Provider attribution and cost

Reasoning artifacts still record the route that answered. FreeLLM image/speech
providers likewise report `provider: freellmapi` and `cost_usd: 0`; the upstream
provider/model is retained where the media API exposes it. Fal and ElevenLabs
retain their existing paid cost accounting when rollback modes are selected.

## Lifecycle caveat

The shared Docker network and FreeLLM media registry are owned by the Shorts
FreeLLMAPI deployment. Long does not add keys, create/toggle media rows, reuse a
dashboard session, or otherwise take ownership of that administrative state.

If the Shorts network is removed/recreated, redeploy Long after Shorts is
healthy. With FreeLLM media selected, Long intentionally refuses to report a
healthy deployment until the selected media routes are genuinely callable; with
Fal/ElevenLabs selected, only reasoning/vision uses the shared route and paid
OpenAI fail-open can keep the pipeline operational.
