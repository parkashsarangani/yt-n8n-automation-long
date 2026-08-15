# VidGen — Autonomous Media Operating System

A compiler from ideas into publishable media. You give it a topic; it researches
nothing yet, writes a story, writes the narration, plans the visuals, generates
images and voice, renders a video, and publishes it — pausing for your approval
at the points that matter.

YouTube is one output target, not the system.

## Run it

```bash
docker compose up --build
```

Then open **http://localhost:4321** and set your Anthropic key in the UI.

That is the whole setup. Everything else is optional: any provider without a
credential falls back to a deterministic fake, so the pipeline runs end to end
from the first minute and gets more real as you add keys.

| Credential | Powers | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | story, script, visual plan | **required** — runs fail at the first node |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | voiceover | silent placeholder audio |
| `PEXELS_API_KEY` **or** `UNSPLASH_ACCESS_KEY` | scene images (free stock) | placeholder images |
| `PIXABAY_API_KEY` | third image fallback | search stops after the first two |
| `YOUTUBE_CLIENT_ID` + `_SECRET` + `_REFRESH_TOKEN` | publishing **and** measurement | dry-run target, no feedback loop |

Keys entered in the UI persist in the `vidgen_data` volume. You can also seed them
from a `.env` beside `docker-compose.yml` — see [`.env.example`](.env.example).

**Check what will actually run.** The settings panel and the startup log both
list every stage as ✓ or ✗, with the exact key that would fix it. A stage
without its credential does not fail — it silently substitutes a stand-in and
the run still reports success, which is the expensive way to find out.

**Measuring needs a re-authorization.** The feedback loop reads YouTube
Analytics, which needs the `yt-analytics.readonly` scope. A refresh token minted
before this existed authenticates fine and then returns 403 — Google will not
widen an existing grant.

Check what your current token has (this also refreshes the access token):

```bash
cd engine && npm run youtube-token
```

If it reports the analytics scope missing, re-authorize once:

```bash
cd engine && npm run youtube-token -- --auth
```

It prints a URL, waits on `http://localhost:8976` for the redirect, and writes a
new refresh token. **`http://localhost:8976` must be listed as an authorized
redirect URI** on your OAuth client in the Google Cloud console, or the consent
screen will reject it.

> Run it from `engine/`, not the repo root — `tsx` is a dependency of that
> package, so `node --import tsx` cannot resolve from the root.

**Publishing never happens by accident.** A YouTube token alone does nothing;
you must also start with `AMOS_ALLOW_PUBLISH=1`, and uploads are always private.

## What you get in the UI

- A topic box and a target length.
- **Live step status** — which node is running right now, which are done,
  waiting, failed, or blocked.
- **Two review gates.** The story premise (auto-passes on high confidence), and
  the **narration script**, which always asks. The script gate sits *before* any
  image or voice generation, so rejecting a script costs one model call rather
  than eighty images.
- Per-run cost.

## Services

```
engine         the system: agents, execution graph, artifact store, control UI
long-compose   video assembly (FFmpeg + Remotion)
n8n            legacy — the pre-VidGen pipeline, see below
```

Both published ports bind to `127.0.0.1` deliberately: the UI holds API keys and
is unauthenticated by design. Do not expose it.

## Running on the HP server

VidGen shares the box with the Shorts stack. Ports are offset so the two never
collide:

| | Shorts | VidGen |
|---|---|---|
| renderer | `4000` | **`4001`** (`long-compose`) |
| n8n | `5678` | **`5679`** (legacy, not started) |
| control UI | — | **`4321`** (`engine`) |

Deploy by pushing to `main` — the self-hosted runner builds both images, starts
them, and health-checks each one. Or by hand on the box:

```bash
docker compose up -d --build
```

`restart: unless-stopped` brings both services back after a reboot.

### One-time migration

The compose project was renamed `yt-longform` → `vidgen`. Volumes are
project-prefixed, so without this step the new stack starts with **empty**
volumes and the old containers keep holding port 4001. The deploy runs it
automatically; to do it manually:

```bash
bash scripts/migrate-from-yt-longform.sh
```

It stops the old project and copies each volume across. Non-destructive — the
old volumes are left in place for you to delete once you are satisfied.

### Reaching the UI from your laptop

The UI binds to loopback on the server, so `http://server:4321` will not answer
and is not meant to. Forward the port over SSH instead:

```bash
ssh -N -L 4321:127.0.0.1:4321 you@hp-server
```

Leave that running and open **http://localhost:4321** on your laptop. The
browser sends `Host: localhost`, which is what the server's Host-header check
requires, so this works with no configuration change.

> **Do not put this behind a Cloudflare Tunnel or a reverse proxy.** Unlike n8n,
> the UI has no login: anyone who reaches it can read your masked credentials,
> overwrite your keys, and spend your API budget. Loopback plus SSH *is* the
> auth. If you ever need real remote access, the UI needs an auth layer first.

### Memory

`long-compose` is capped at 6G because Remotion renders in headless Chromium.
The Shorts renderer has its own budget on the same machine — if both render at
once on a 16G box you are at the edge. Lower `COMPOSE_CONCURRENCY` (default 3)
before raising the cap.

### The legacy n8n pipeline

The original n8n A/B pipeline still exists but has no role in VidGen — the engine
owns the execution graph and the UI owns human approval. It is parked behind a
profile so it does not start by default:

```bash
docker compose --profile legacy up
```

Its workflow and build spec remain in [`n8n/`](n8n).

## How it works

Read [`docs/`](docs) — eight RFCs covering the irreversible decisions. The short
version, five rules everything else derives from:

1. Workers never think.
2. Agents never touch files.
3. Artifacts are immutable.
4. Everything is observable.
5. Every transformation is reproducible.

## Developing

```bash
cd engine
npm install
npm test          # 148 tests, no network, no API keys
npm run typecheck
npm run ui        # the UI without Docker, on the host
```

See [`engine/README.md`](engine/README.md) for the module map, the invariants under
test, and what implementation revealed about the RFCs.

## Status

The pipeline runs end to end for real: intent → published episode. Every adapter
has made live calls, and the scars are in the log — Remotion argv limits, payload
caps, render timeouts, connection-pool exhaustion.

Being built now, in dependency order:

| | Status |
|---|---|
| Credentials + capability check | **done** |
| Thumbnail | **done** |
| SEO (title, description, tags) | **done** |
| Feedback loop (YouTube Analytics → strategy) | **done** |
| Discovery (topic selection, informed by feedback) | next |
| Scheduler | |

Deliberately still out: Research, Fact Checking, and the knowledge graph.

## Licensing

See [`LICENSES.md`](LICENSES.md). Inter is SIL OFL. The icon set is CC-BY 4.0 and
**requires attribution to useanimations.com** — a carried-over open item.
