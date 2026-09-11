# Reference-style audio release

- The long-form programme stays 1920×1080. One text-free editorial image is generated separately from the thumbnail, with plain-background fallback when image billing/access is unavailable.
- Caption cards, role labels and scene counters are removed. Short phrases use ElevenLabs character timing when valid and text-matching; old artifacts use proportional timing within measured scene durations. The package title is a persistent heading.
- Completed speech/image calls write usage immediately via worker progress records. Failed downstream work does not erase those charges. These are provider estimates, not reconciled invoices; free LLM calls remain zero.
- `ELEVENLABS_SPEED` is configurable through the existing config API. Default 0.9 is provisional, not an auditioned production calibration. The operator selected voice `gZiz6WFdAxF6MKJ0s5s6`; deployment and Compose defaults now use it. Existing successful voice artifacts are preserved until explicitly regenerated.

## Required live acceptance

1. Resolve fal billing before assessing the artwork path. A fallback render does not verify fal generation.
2. Audition two or three warm, assured, conversational adult narrators against the same approved 60–90-word scene. Avoid sales-pitch energy or exaggerated dramatic delivery. Select for credibility, clear emphasis and natural pauses, not depth alone.
3. Start at speed 0.9, measure words divided by actual audio minutes, and listen for rushed endings. Target 130–150 WPM provisionally; remeasure for each selected voice. Keep the existing script word-count guidance unchanged until this check.
4. Update `ELEVENLABS_VOICE_ID` and `ELEVENLABS_SPEED` using the engine config UI/API, then explicitly regenerate voice for an existing episode or start fresh. Resume alone preserves successful old voice artifacts.
5. Inspect the final MP4 for readable captions, synchronisation and background quality. Confirm media usage appears in run costs. Review privately before publishing.

Not verified in development: paid voice auditions, fal generation, production deployment, or a full live episode. A successful prior render retains its artwork blob for explicit rerenders; an image generated during a render that fails before artifact creation may be generated again on retry.
