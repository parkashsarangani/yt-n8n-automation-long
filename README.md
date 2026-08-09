# YouTube Long-form Automation Pipeline

A fully automated pipeline for **8–10 minute long-form YouTube videos**, built to
A/B test two content niches — **Geography** and **Historical Mysteries** — through
one parameterized pipeline before committing to a niche long-term.

This is a separate project from the Shorts pipeline
([`yt-n8n-automation`](https://github.com/parkashsarangani/yt-n8n-automation)).
It shares DNA with it (n8n + Claude + ElevenLabs + Fal + a hybrid Remotion/FFmpeg
compositor) but the chunking logic differs at every stage — script generation,
TTS, B-roll volume, render scaling — so it lives on its own.

## Status

**MVP, in build.** The design is fully specified in
[`n8n/long-form-mvp-spec.md`](n8n/long-form-mvp-spec.md) — read that first; it is
the source of truth for the node graph, prompt templates, retry/failure semantics,
the thumbnail step, and the per-run cost logging.

Build order: (1) `n8n/long-form.json` workflow · (2) the two `compose/compose.js`
edits (scene-concurrency cap, Ken-Burns upscale reduction) · (3) 3-video pilot to
validate retention + pipeline reliability · (4) full interleaved A/B run.

## Architecture (long-form specifics)

```
n8n (orchestration) — long-form.json
  ├─ Claude — niche-seeded topic → blueprint → per-act script loop (avoids truncation)
  │           → editorial pass → dedicated visual-plan enrichment
  ├─ ElevenLabs — per-section TTS with previous_text/next_text for voice continuity
  ├─ Fal flux/dev — 40–80 AI images (search_terms → prompt; fallback_terms; gradient placeholder)
  ├─ compose (this repo) — hybrid Remotion + FFmpeg assembly (vendored from the Shorts compositor,
  │           with a scene-concurrency cap + raised async poll budget for 10-min renders)
  ├─ Thumbnail — dedicated 16:9 Fal image + templated text overlay (identical template per niche,
  │           for A/B validity), set via YouTube thumbnails.set
  └─ YouTube Data API — upload, AI-content disclosure, per-run cost logging
```

## Why a separate niche A/B, briefly

- **Decision metric:** CTR + average-view-duration (low variance, resolvable at
  ~12–15 videos/arm); revenue/views is directional-only (landslide ≥2× to count).
- **Timeline:** judge each video on 28-day matured metrics → real read at ~6–8 weeks,
  not 2. Alternate niches day-by-day (A B A B), never in blocks.
- **Break-even:** ~650–1,200 views/video at $5–7 RPM; per-video API cost (~$3–6) and
  the ~$135 total test cost are a rounding error next to calendar time.

See the spec and the project notes for the full experiment design.

## Repo layout

```
n8n/
  long-form-mvp-spec.md        - build spec (READ FIRST): nodes, prompts, retry/failure, thumbnail, logging
  long-form.json               - the n8n workflow (to be generated from the spec)
compose/                       - vendored video-composition service (self-contained)
  compose.js                     - async job API + hybrid Remotion/FFmpeg pipeline
  Dockerfile, package.json
  remotion/                      - studio motion graphics + caption/thumbnail compositions
  motion-assets/                 - fonts, icons, backgrounds, sfx (see LICENSES.md)
docker-compose.yml             - deploys n8n + compose (namespaced 'yt-longform'; ports offset to co-exist with Shorts)
```

## Setup

### 1. Credentials (configure in n8n, not in this repo)

- Anthropic (Claude) API key
- ElevenLabs API key + voice ID
- Fal API key
- YouTube Data API v3 (OAuth2) — **the channel must be phone-verified**, or custom
  thumbnails 403 and every video silently reverts to auto-frame (which re-introduces
  the exact thumbnail bias the A/B is designed to avoid).

### 2. Deploy the stack

```bash
docker compose up -d --build
```

The compose service and n8n are **namespaced and port-offset** (n8n on host `5679`,
compose on host `4001`, volumes prefixed `lf_`) so this stack can run on the same
Ubuntu server as the Shorts stack without colliding on ports or sharing state.
If you run it on a separate host, revert the port offsets in `docker-compose.yml`.

### 3. Cloudflare Tunnel / hostnames

Point long-form-specific subdomains at this stack (e.g. `n8n-lf.<domain>` →
`localhost:5679`, `compose-lf.<domain>` → `localhost:4001`). The n8n workflow and
`WEBHOOK_URL` reference these hostnames — set them before the first run.

### 4. Import the workflow

Import `n8n/long-form.json` into n8n, reconnect each credential, and set the niche
input parameter (`geography` | `historical_mysteries`) per run.

## Licensing

See [`LICENSES.md`](LICENSES.md). Inter (SIL OFL, no attribution). Icon set is
CC-BY 4.0 — **attribution to useanimations.com is required** on the channel and is a
carried-over open TODO. SFX are synthesized (no third-party licensing).
