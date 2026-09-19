# VidGen Long

Audio-first long-form YouTube production pipeline. The engine selects and packages a story, writes and moderates narration, synthesizes timestamped speech, assembles a minimal 1080p MP4, designs a thumbnail, and delivers the draft to a human editor's Google Drive folder. The editor finishes the cut and uploads to YouTube themselves — `editor_review` is where the pipeline's work ends.

## Run locally

```bash
docker compose up --build
```

- Studio/API: http://localhost:4321
- Compositor: http://localhost:4001

## Production configuration

| Variable | Purpose | Without it |
|---|---|---|
| `FREELLMAPI_API_KEY` | Free-first text reasoning | Use explicit direct rollback only |
| `OPENAI_API_KEY` | Paid text fallback and pre-TTS moderation | Moderated production cannot proceed |
| `ELEVENLABS_API_KEY` | Narration | Fake speech in non-production runs |
| `ELEVENLABS_VOICE_ID` | Narrator voice | Test-only placeholder voice |
| `FAL_KEY` | Optional thumbnail artwork | Gradient thumbnail background |
| `COMPOSE_URL` | FFmpeg compositor | Fake renderer in non-production runs |
| Drive OAuth trio + `DRIVE_ROOT_FOLDER_ID` | Editor hand-off | Runs cannot reach the editor |
| `OPERATOR_ALERT_WEBHOOK_URL` | Alert when a run is abandoned | Failures are only logged |
| `EDITOR_RETURN_WATCH_ENABLED` | Re-enable the dormant editor-return flow | Runs finish at `editor_review` (current behaviour) |
| YouTube OAuth trio | Upload and analytics | Dry-run publishing / no analytics |
| `AMOS_ALLOW_PUBLISH` | Explicit upload switch | No live upload |

Text routing uses the shared FreeLLMAPI network and may fall back to OpenAI only when `PAID_TEXT_FALLBACK=true`. Scene-image, generated-video, stock-media, visual-director, Remotion, and legacy n8n production paths are intentionally absent.

Note that the YouTube variables are currently inert: the graph's `finalize_video → qa → publish` tail sits behind `editor_review`, which nothing advances while the editor publishes directly (see below). The nodes and workers are retained deliberately so the self-publishing flow can be restored without rebuilding it.

## Quiet Confidence — Season 1

The first editorial series is an eight-episode audio-first course in practical social intelligence. Each episode is self-contained but builds a reusable skill: entering unfamiliar rooms, starting and sustaining conversations, expressing interest without pressure, handling interruptions, setting boundaries, accepting rejection, and having difficult conversations. Fictional scenarios are labelled as examples; scripts must explain limitations and end with a concrete exercise.

Use the Studio's **Quiet Confidence — Season 1** selector, or start an episode through `POST /api/series/quiet-confidence-v1/episodes` with `{ "episode": 1 }` through `{ "episode": 8 }`. Series runs carry typed episode context in `intent@2.1.0` to keep the selected objective available to the writer and critic. Topic fidelity is editorially reviewed; the schema alone cannot prove it.

The [retention review](docs/quiet-confidence-retention-review.md) describes the reusable packaging, opening, story, critique and revision workflow, its checks and its measurement limits. A critic's revision verdict blocks release even when its numeric scores are high. Existing publishing configuration applies to series runs.

## Editor hand-off

`editor_package` uploads the draft, transcript and beat list to a dated Drive subfolder and the run parks at `editor_review`. That wait is the pipeline's **successful terminal state**, not a stall: the editor finishes the cut and uploads to YouTube outside this system.

The original design expected the editor to drop a `final.mp4` back into Drive, which `checkEditorReturns()` would pick up to drive `finalize_video → qa → publish` and then measure performance. That return trip no longer happens, so the poll is off by default. Set `EDITOR_RETURN_WATCH_ENABLED=true` to restore it. One consequence worth knowing: the `measure` job consumes `published_episode` artifacts, which only the `publish` node produces, so episodes handed to the editor are not measured automatically.

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
