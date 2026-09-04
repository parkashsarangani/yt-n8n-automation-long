# Shared FreeLLMAPI routing

The Long pipeline uses the same FreeLLMAPI instance already deployed by the
Shorts repository on this server. It does **not** deploy another FreeLLMAPI
container, database volume, or copy of the Shorts `llm-gateway`.

## Runtime architecture

```text
Long reasoning agents ---- ProviderRouter/OpenAIProvider ----+
                                                             |
Long illustration vision QA --------------------------------+
                                                             |
                                      LLM_ROUTER_MODE=freellmapi
                                                             |
                                   shared freellmapi:3001
                                   (owned by Shorts stack)
                                                             |
                                     free hosted providers

                              on outage/quota/error, when enabled
                                                             |
                                      direct paid OpenAI
                                      (owned by Long)
```

The ownership split is deliberate:

- `yt-n8n-automation-shorts` owns the pinned FreeLLMAPI container, its encrypted
  SQLite state, the upstream free-provider credentials, and the Docker network
  `yt-n8n-automation-shorts_default`.
- `yt-n8n-automation-long` owns its application-level routing policy and its
  direct OpenAI fail-open credential.
- Long uses only FreeLLMAPI's unified client key. It does not need or receive the
  individual upstream provider keys stored by the shared FreeLLMAPI instance.
- Long does not use the Shorts `llm-gateway`; doing so would couple Long to the
  Shorts gateway lifecycle and its paid fallback credentials.

This keeps one copy of FreeLLMAPI on the resource-constrained host while keeping
paid fallback/accounting isolated per application.

## Activation

1. Make sure the Shorts FreeLLMAPI deployment is configured and healthy. Its
   dashboard remains loopback-only on host port `127.0.0.1:3001`.
2. Use the same FreeLLMAPI unified key for Long. Store it as the Long production
   secret `FREELLMAPI_API_KEY`, or expose one organization/environment secret to
   both repositories. Do not commit the key.
3. Deploy Long normally. The deployment locates the Long `engine` container,
   attaches it to `yt-n8n-automation-shorts_default`, then checks
   `http://freellmapi:3001/api/ping` from inside that container.
4. The shared network name can be overridden with the Long repository variable
   `SHARED_LLM_NETWORK` if the Shorts Compose project identity changes.

The network/FreeLLMAPI health check is warning-only. A missing shared network or
FreeLLMAPI outage must not prevent the Long stack from deploying when paid
fail-open is available.

## Routing controls

```text
LLM_ROUTER_MODE=freellmapi
LLM_ROUTER_FAIL_OPEN_TO_DIRECT=true
FREELLMAPI_BASE_URL=http://freellmapi:3001/v1
FREELLMAPI_TEXT_MODEL=auto:smart
FREELLMAPI_VISION_MODEL=auto:smart
LLM_ROUTER_TIMEOUT_MS=120000
```

`LLM_ROUTER_MODE=freellmapi` is the default. Reasoning requests use
`FREELLMAPI_TEXT_MODEL`; illustration text checks, semantic checks, hero ranking,
and episode-level visual review use `FREELLMAPI_VISION_MODEL`.

When `LLM_ROUTER_FAIL_OPEN_TO_DIRECT=true`, a FreeLLMAPI reasoning failure is
retried through the existing direct OpenAI provider. That fallback preserves the
Long pipeline's streaming SSE implementation. Vision QA also retries through
direct OpenAI; if both routes are unavailable, vision QA preserves its existing
non-blocking behavior and returns no review rather than deadlocking production.

Set `LLM_ROUTER_FAIL_OPEN_TO_DIRECT=false` for strict zero-paid-call behavior.
In that mode a FreeLLMAPI reasoning failure blocks the reasoning node and vision
QA simply becomes unavailable for that check; the code will not invoke paid
OpenAI.

## Immediate rollback

Set:

```text
LLM_ROUTER_MODE=direct
```

and restart/redeploy Long. Reasoning and vision QA then bypass FreeLLMAPI and use
Long's existing OpenAI configuration. No code revert and no Shorts deployment is
required.

## Provider attribution and cost

Generated reasoning artifacts record the provider that actually answered:

- `freellmapi/<actual-model>` when the free route succeeds;
- `openai/<model>` when direct mode or paid fail-open answers.

FreeLLMAPI-routed calls are recorded with `cost_usd: 0` in the Long run log;
direct OpenAI calls retain the existing model-specific cost estimate. This makes
unexpected paid fail-open visible in episode/run cost telemetry instead of
silently attributing it to the free route.

Router fallback logs intentionally contain no prompts, response bodies, API
keys, or upstream provider error bodies.

## Lifecycle caveat

The shared Docker network is owned by the Shorts Compose project. If that Compose
project/network is deliberately removed and recreated, the running Long engine
may lose its attachment. Long's paid fail-open still works because it does not
use that network; redeploy Long after the Shorts network is restored to reattach
the engine to the free route.
