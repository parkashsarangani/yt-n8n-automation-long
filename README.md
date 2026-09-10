# VidGen Long

Audio-first long-form YouTube production pipeline. The engine selects and packages a story, writes and moderates narration, synthesizes timestamped speech, assembles a minimal 1080p MP4, designs a thumbnail, validates technical output, publishes, and feeds YouTube performance back into future selections.

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
| YouTube OAuth trio | Upload and analytics | Dry-run publishing / no analytics |
| `AMOS_ALLOW_PUBLISH` | Explicit upload switch | No live upload |

Text routing uses the shared FreeLLMAPI network and may fall back to OpenAI only when `PAID_TEXT_FALLBACK=true`. Scene-image, generated-video, stock-media, visual-director, Remotion, and legacy n8n production paths are intentionally absent.

## Quiet Confidence — Season 1

The first editorial series is an eight-episode audio-first course in practical social intelligence. Each episode is self-contained but builds a reusable skill: entering unfamiliar rooms, starting and sustaining conversations, expressing interest without pressure, handling interruptions, setting boundaries, accepting rejection, and having difficult conversations. Fictional scenarios are labelled as examples; scripts must explain limitations and end with a concrete exercise.

Use the Studio's **Quiet Confidence — Season 1** selector, or start an episode through `POST /api/series/quiet-confidence-v1/episodes` with `{ "episode": 1 }` through `{ "episode": 8 }`. Series runs carry typed episode context in `intent@2.1.0` to keep the selected objective available to the writer and critic. Topic fidelity is editorially reviewed; the schema alone cannot prove it.

The [retention review](docs/quiet-confidence-retention-review.md) describes the reusable packaging, opening, story, critique and revision workflow, its checks and its measurement limits. A critic's revision verdict blocks release even when its numeric scores are high. Existing publishing configuration applies to series runs.

## Verification

```bash
cd engine && npm ci && npm run typecheck && npm test
cd ../long-compose && npm ci && npm run check && npm test
docker compose config
```
