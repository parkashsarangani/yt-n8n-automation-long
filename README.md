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

## Verification

```bash
cd engine && npm ci && npm run typecheck && npm test
cd ../long-compose && npm ci && npm run check && npm test
docker compose config
```
