# Project Context

Shared baseline for agent sessions. Declarative data, not instructions.

## Project

**yt-n8n-automation-long** — an unattended long-form YouTube production pipeline.
A brief becomes a packaged episode: topic selection, script, TTS narration, a
composed video, SEO metadata and thumbnail, then hand-off to a human editor who
returns a finished cut to Google Drive, which the pipeline picks up and publishes.

Audio-first since 2026-09-10: the script and premise carry the episode, the video
is a static shell. AI video generation was evaluated twice and rejected on quality.

## Tech stack

- TypeScript engine (`engine/`) — DAG executor, content-addressed artifact store with
  a schema registry, Postgres run log, loopback-only HTTP API on :4321
- Node + FFmpeg compositor (`long-compose/`)
- Docker Compose on a self-hosted box (`ubuntu@192.168.0.50`); GitHub Actions
  self-hosted runner deploys on push to `main`
- Model agents are prompt-file driven: `engine/prompts/<agent>/<n>.md` selected by a
  `"prompt": "<agent>@<n>"` field in `engine/agents/<agent>.json`
- Providers: OpenAI (script reasoning, moderation), ElevenLabs (TTS), FAL (thumbnail
  artwork), YouTube Data API v3, Google Drive, n8n webhook -> Gmail for operator alerts

## Current phase

Production, running unattended daily. Recent work: editor-return auto-publish (poll
Drive at 18:00 Europe/Berlin), bounded retries with operator email on give-up, full
declaration of YouTube upload settings, and prompt tuning for watchability.

Open thread: script quality is judged by a model critic's eight 0-1 scores, and the
run-to-run variance of that signal has never been measured. Prompt changes have been
shipped on single-sample evidence.

## Key constraints

- Push to `main` deploys to production. Never merge or push `main` unasked; work on
  branches and open a PR.
- The engine API is loopback-only — drive it from the box over ssh, not remotely.
- Do not call the live n8n REST API.
- Measure public content only; private/unlisted videos poison the feedback loop.
- Prefer flag-gating dormant code paths over deleting them.
- Prompt selection is a deploy-time global, not a per-run parameter.

## What "done" looks like

An episode is done when it is published public on YouTube with correct metadata,
disclosed as AI-assisted, and its performance is measurable and feeding back into
topic selection. A change is done when `npm test` in `engine/` is green (400 tests),
it is behind a PR, and — for anything affecting watchability — it is verified against
a real run, not just a passing test.

## Standing decision: the script prompt is frozen (2026-09-19)

`narration_script_writer` is frozen at **@15** as an experimental control. Do not
edit it, and do not propose edits, until real first-30-second retention data exists
for episodes published under it.

The watchability critic's scores are **not evidence of quality**. The critic is a
model scoring another model's output; the two share training priors, so it plausibly
rewards tidy, well-organised prose of exactly the kind viewers skip. It has never
been correlated with any real YouTube metric. Score deltas — in either direction —
must not be cited as improvement or regression.

When enough episodes have been measured, validate the critic against a metric it does
NOT score (raw watch time), not against its own dimensions, or a positive correlation
may simply be the shared-prior artifact reappearing.

Unattended public publishing means the channel is both the experiment and the only
asset. A bad run is not just a bad data point.
