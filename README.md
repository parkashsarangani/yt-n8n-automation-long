# VidGen Long

Audio-first long-form YouTube production pipeline. The engine selects and packages a story, writes and moderates narration, synthesizes timestamped speech, assembles a minimal 1080p MP4, designs a thumbnail, and delivers the draft to a human editor's Google Drive folder. The editor returns the finished cut to that folder and the pipeline publishes it to YouTube, then feeds measured performance back into future topic selection.

## Run locally

```bash
docker compose up --build
```

- Studio/API: http://localhost:4321
- Compositor: http://localhost:4001

Both are published to `127.0.0.1` only — deliberately, since the local Studio holds API keys. They are not reachable from another machine without an explicit tunnel or reverse proxy.

## Production configuration

| Variable | Purpose | Without it |
|---|---|---|
| `FREELLMAPI_API_KEY` | Free-first text reasoning | Use explicit direct rollback only |
| `OPENAI_API_KEY` | Paid text fallback and pre-TTS moderation | Moderated production cannot proceed |
| `ELEVENLABS_API_KEY` | Narration | Fake speech in non-production runs |
| `ELEVENLABS_VOICE_ID` | Narrator voice | Test-only placeholder voice |
| `FAL_KEY` | Optional thumbnail artwork | Gradient thumbnail background |
| `COMPOSE_URL` | FFmpeg compositor | Fake renderer in non-production runs |
| `FOOTAGE_MODE` | Stock footage lookup (default `stock`) | Plain background behind narration |
| `PEXELS_API_KEY` / `UNSPLASH_ACCESS_KEY` | Stock media sources | Unmatched scenes use the background |
| Drive OAuth trio + `DRIVE_ROOT_FOLDER_ID` | Editor hand-off | Runs cannot reach the editor |
| `OPERATOR_ALERT_WEBHOOK_URL` | Alert when a run is abandoned | Failures are only logged |
| `EDITOR_RETURN_WATCH_ENABLED` | Daily sweep for the editor's returned cut | Runs stop at `editor_review`, nothing publishes |
| `SCHEDULE_EDITOR_WATCH_LOCAL_HOUR` | Hour of that sweep (default 18) | 18:00 in the produce timezone |
| `EDITOR_RETURN_WEBHOOK_TOKEN` | Enables the on-demand pickup route (unset = off) | That route 404s; the daily sweep still runs |
| YouTube OAuth trio | Upload and analytics | Dry-run publishing / no analytics |
| `AMOS_ALLOW_PUBLISH` | Explicit upload switch | No live upload |
| `YOUTUBE_CATEGORY_ID` / `YOUTUBE_LANGUAGE` | Upload category (default 27, Education) and BCP-47 language (default `en`) | YouTube guesses both |
| `YOUTUBE_PAID_PROMOTION` | Declares paid product placement | Declared `false` on every upload |

Text routing uses the shared FreeLLMAPI network and may fall back to OpenAI only when `PAID_TEXT_FALLBACK=true`. Scene-image, generated-video, visual-director, Remotion, and legacy n8n production paths are intentionally absent. Stock footage is *not* — `FOOTAGE_MODE` defaults to `stock`, and the compositor pulls suggested Pexels/Unsplash media, falling back to a plain background when a key is missing or nothing matches.

The YouTube variables are live: the graph's `finalize_video → qa → publish` tail runs as soon as the editor returns a cut (see below), so `AMOS_ALLOW_PUBLISH` plus the OAuth trio are what stand between a returned file and a public upload.

## Second Thoughts — Season 1

The current editorial series, **Second Thoughts**, is an eight-episode audio-first course in everyday psychology. Each episode is self-contained but builds a reusable habit around one thinking trap: reading silence as rejection, adding tone that is not there, sunk cost, procrastination, the spotlight effect, anchoring, comparison, and changing your mind. Fictional scenarios are labelled as examples; scripts must explain limitations, never invent research, and end with a concrete exercise. (It replaced the earlier Quiet Confidence social-skills series, whose runs remain valid.)

The daily scheduler produces these eight episodes in order, one a day, then stops (`SCHEDULE_PRODUCE_SOURCE=discovery` restores open-ended topic discovery). To start one by hand, use the Studio's **Second Thoughts — Season 1** selector or `POST /api/series/everyday-psychology-v1/episodes` with `{ "episode": 1 }` through `{ "episode": 8 }`. Series runs carry typed episode context in `intent@2.2.0` to keep the selected objective available to the writer and critic. Topic fidelity is editorially reviewed; the schema alone cannot prove it.

The [retention review](docs/quiet-confidence-retention-review.md) describes the reusable packaging, opening, story, critique and revision workflow, its checks and its measurement limits. A critic's revision verdict blocks release even when its numeric scores are high. Existing publishing configuration applies to series runs.

## Editor hand-off

`editor_package` uploads the draft, transcript and beat list to a dated Drive subfolder and the run parks at `editor_review`. The editor finishes the cut and drops it back into that same folder as `final.mp4` (a `.mov`/`.m4v` export or a `final_v2.mp4`-style name is also accepted; our own `draft.mp4` never is). `checkEditorReturns()` picks it up, substitutes it as the final video, and the run continues through `qa → publish` — uploading to YouTube with the pipeline's SEO title/description/chapters and designed thumbnail, then emitting the `published_episode` artifact that feeds performance measurement back into topic selection.

**There is no confirmation step.** A returned cut becomes a live public video, by operator decision; the only automatic brake is `qa`, which downgrades to private on a non-clean report. If the folder holds no importable cut but does hold editor-added files, or holds two possible cuts, the run alerts instead of waiting silently — a misnamed upload would otherwise stall the episode forever with nobody told. Two further guards protect the bytes rather than the decision: a returned file is only consumed once its size is stable between the download and a re-read of the listing (Drive lists a file when it is *created*, not when the upload finishes), and concurrent callers collapse onto one pass so a webhook cannot race the poll into publishing twice.

Pickup is a single daily sweep at `SCHEDULE_EDITOR_WATCH_LOCAL_HOUR` (default 18:00 Europe/Berlin), gated on `EDITOR_RETURN_WATCH_ENABLED` (`true`, `1` or `yes`). Whatever is in the folder by then is published that evening; anything later waits for the next sweep. `POST /api/editor-returns/check` runs the same check on demand and is the only route reachable from off-box, but it is dormant: it requires `EDITOR_RETURN_WEBHOOK_TOKEN` in an `x-webhook-token` header and 404s entirely while that is unset, which it is. A Drive push trigger was evaluated and dropped — episode folders are subfolders of the root, which folder-scoped Drive triggers do not see, and the latency it bought was not worth a second auth surface that can silently stop firing.

## When a run fails

Retries are bounded at two levels, and only the outer one talks to a human.

| Level | Budget | On exhaustion |
|---|---|---|
| `driveUnattended()` — one attempt | 2 generic resumes; 3 script rewrites for a pre-TTS moderation `review` verdict | Records the failure and returns. Sends nothing. |
| Scheduler `produce` job | `MAX_ATTEMPTS` (3), 15 minutes apart | Calls `onGaveUp` once → operator alert, then stops |

Giving up abandons **that run only** — `retryAt` is cleared rather than the job disabled, so the next day's 03:00 Europe/Berlin slot still fires. The alert is the last thing the pipeline does; nothing further is attempted on that run until a human intervenes.

Alerts POST `{subject, text, run_id, reason, failures}` to `OPERATOR_ALERT_WEBHOOK_URL` (a Slack incoming webhook or an n8n Webhook node both work unmodified), deduplicated per `run_id + reason + failing nodes` for six hours. A moderation `block` verdict is never auto-retried — unlike `review`, it is a confirmed policy violation and always needs a human.

## Verification

The conversation stage displays approved narration in bounded phrase cards on a dark 1080p canvas. Scene-role headings distinguish situations, responses, explanations, context, exercises and takeaways. Text is paginated without dropping words, with subtle fades and scene progress. Scene boundaries use measured audio duration; within-scene page timing is proportional to text length, not word-synchronised captions. No additional image provider or visual-generation agent is required. Legacy requests without narration retain the plain background.

```bash
cd engine && npm ci && npm run typecheck && npm test
cd ../long-compose && npm ci && npm run check && npm test
docker compose config
```
