# Long-form MVP — build spec (lean)

Status: build spec for review. Flat model (1 scene = 1 beat = 1 TTS call = 1 Fal image = 1 alignment),
~40–50 scenes, ~1,200–1,500 words. Vendors the Shorts compositor as `long-compose/` with two edits (see §7).
Visual source = Fal `flux/dev` (unchanged from Shorts; NOT Pexels).

**Lean design (this revision):** 2 Claude stages instead of 5 — topic-selection folded into the blueprint,
and the visual-plan enrichment folded into the act-writer. Separate editorial + enrichment stages removed
(see §5). Per-scene template routing removed (long-form has no in-scene templates; the outro card is handled
inside `long-compose`). Single-path retry. Result: ~38 nodes (n8n's async-poll + two per-scene loops floor the
count at ~12 scaffolding nodes) down from ~48.

Empirical placeholders pending channel data: view-count CV `TBD-from-channel-data`,
CTR viability floor `TBD-from-channel-data`. Decision metrics: CTR + avg-view-duration primary,
revenue/views landslide-only (see the A/B protocol in chat).

---

## 1. Node graph (`long-workflow.json`)

```
Trigger (Manual + Schedule ≤1/day)
  → Set Niche Param                     # {niche: "geography" | "historical_mysteries"}
  → Resolve Niche Config                # code: niche → {topicSeed, visualStyle, captionStyle, voiceId, tone, accent}
  → Get Topic History (per-niche key)   # HTTP, continueOnFail
  → Prep                                # code: ensure topics[] + init scriptAttempt=0  (merged)
  → Claude: Blueprint + Topic (Stage A) # Opus 4.8 — picks topic from history AND builds skeleton + thumbnail fields
  → Parse Blueprint                     # code
  → Loop Over Acts (splitInBatches)     # body ↓ ; done → Assemble Full Script
        → Claude: Write Act (Stage B)   # Opus 4.8 — scenes: narration + per-scene visual plan, one call per act
        → Parse + Accumulate Act        # code
        → (loop back)
  → Assemble Full Script                # code: concat act scenes → scenes[] (global index) + append spoken outro scene
  → Validate Final Script               # code: gates §6 ; tags errors with .stage ; sets _scriptValid
  → If Script Valid
      TRUE → Split Out Scenes  +  Save Topic to History (per-niche)
      FALSE → Increment Attempt → If Under Max (<3) → back to Blueprint+Topic ; else Fail  (single-path, §10)
  → [parallel branches off Split Out Scenes]
        (audio)  ElevenLabs TTS (prev/next_text, §8) → Tag Audio → Aggregate Audio
        (visual) Loop Scenes → Fal Image (search_terms → fallback_terms → gradient, §6c) → Tag Image → Aggregate Visuals
  → Wait Both Branches → Merge by scene_index
  → Fal: Thumbnail Image (§11)          # dedicated 16:9 image from thumbnail_concept
  → Start Compose Job (/compose)        # payload carries scenes + thumbnail image + thumbnail_text;
                                        #   long-compose renders BOTH the video and the thumbnail PNG (§11)
  → Init Poll → Wait → Check Status → If Processing → Increment → If Under Max (raised, §7) [loop]  (else Fail)
  → Validate Compose → Download Video (+ thumbnail) → YouTube Upload → Set Thumbnail (§11)
  → Disclose AI → Log Run (§9) → Cleanup
```

No per-scene `If Template`/`Tag Template`. No separate editorial or enrichment nodes.

---

## 2. Niche config (Resolve Niche Config code node)

```js
const CONFIG = {
  geography: {
    topicSeed: "geography — why places are the way they are: borders, terrain, climate, cities, trade, why-is-X-shaped-like-that. Recognizable countries/landmarks preferred.",
    visualStyle: "vivid explanatory geography documentary, aerial and satellite feel, rich natural color",
    captionStyle: "neutral",
    voiceId: "UgBBYS2sOqTuMpoF3BR0",
    tone: "curious, clear, explanatory",
    accent: "#2E86DE",
  },
  historical_mysteries: {
    topicSeed: "historical mysteries — unexplained disappearances, lost places, unsolved events, famous figures with a hidden gap in the record. Recognizable names/events preferred.",
    visualStyle: "mysterious historical documentary, dramatic low-key lighting, aged and cinematic",
    captionStyle: "serious",
    voiceId: "UgBBYS2sOqTuMpoF3BR0",
    tone: "ominous, intriguing, story-driven",
    accent: "#E67E22",
  },
};
const niche = $json.niche;
const cfg = CONFIG[niche];
if (!cfg) throw new Error(`Unknown niche "${niche}" — must be one of ${Object.keys(CONFIG).join(", ")}`);
return { json: { niche, ...cfg } };
```

Per-niche topic-history key: pass `?niche=<niche>` to the history endpoint.

---

## 3. Stage A — Blueprint + Topic (Opus 4.8, adaptive thinking, effort high, ~2.5k out)

Picks the topic (given history, for dedup) **and** builds the skeleton in one call — folds the old two-node topic step in.

> You are the head writer for a long-form YouTube channel (8–10 minute videos) in the **{{niche}}** niche.
> {{topicSeed}}
>
> STEP 1 — pick a topic not closely resembling any already used: {{usedTopics}}. Start from a recognizable subject; the angle is a surprising, specific, groundable truth about it. No medical/health topics (hard exclusion).
>
> STEP 2 — design the SKELETON, not the full script. Plan the ending first: the hook, the single payoff/kicker that ends the video, and one one-tap engagement question woven in around the two-thirds mark. Structure: intro hook (~30–40s) → **3–5 acts**, each escalating (BUT/THEREFORE, never AND-THEN) → payoff → short spoken outro (drives shares, not a repeat of the mid question).
>
> Output ONLY JSON: {"topic": string, "title": string (≤70 chars, stakes+emotion, withhold the resolution), "hook": string, "outro_line": string (8–16 words), "comment_hook": string (one-tap question), "thumbnail_text": string (≤5 words, punchy, withholds the resolution), "thumbnail_concept": string (one striking single subject for a 16:9 frame — no readable text, no real faces), "seo_description": string, "tags": [8–15 strings], "caption_style": "{{captionStyle}}", "acts": [{"act_index": number, "act_title": string, "premise": string, "target_words": number (~250–350)}]}
>
> Respond with ONLY the JSON object.

`Parse Blueprint` extracts the block (defensive JSON repair, as in Shorts). `Save Topic to History` stores `topic`.

---

## 4. Stage B — Act-writer + per-scene visual plan (Opus 4.8, loop per act, ~2.5k out each)

One call per act writes the act's scenes **with narration and the visual plan together** — folds the enrichment stage in.
Because narration and visuals are produced in the same call, they never drift (no later pass rewrites narration).

> You are writing ONE act of a long-form {{niche}} video. Voice: {{tone}} — a smart friend telling a gripping story, reacting to the material, never a textbook.
>
> You have the blueprint and summaries of the acts already written. Write ONLY this act's scenes, continuing seamlessly (don't repeat prior acts; deepen them). Each scene = one narration beat of ~25–40 words, and every scene must re-hook (micro-cliffhanger / raised stake / question the next scene answers). Hit ~{{target_words}} words. If this act contains the two-thirds mark, weave in the comment_hook question naturally.
>
> For EACH scene also output its visual plan (concrete, generatable concepts for an AI image model):
> - `search_terms`: 3–6 concrete, photographable subjects literally in THIS scene's narration (objects/places/actions — "roman legionary helmet", "misty highland valley", "aerial river delta" — never abstractions). Visually DISTINCT from adjacent scenes.
> - `visual_style`: 2–4 words (default "{{visualStyle}}"; vary tastefully).
> - `fallback_terms`: 2–4 broader backups for when generation fails/blocks.
> NEVER put readable text, numbers, documents, screens, currency, logos, or faces of real named people in a visual term.
>
> Output ONLY JSON: {"act_index": {{act_index}}, "scenes": [{"scene_index": number (continue from {{next_scene_index}}), "point": string, "narration": string, "search_terms": [string], "visual_style": string, "fallback_terms": [string]}], "act_summary": string (2 sentences, for the next act's context)}
>
> Blueprint: {{blueprint}}
> Acts already written (summaries): {{prior_act_summaries}}
> Write act: {{act}}

Loop mechanics: `Loop Over Acts` (splitInBatches) carries `blueprint`, accumulated `prior_act_summaries`,
`next_scene_index`. Each iteration appends its scenes + `act_summary`. Per-act calls (~8–12 scenes) keep the
JSON small and reliable — this is also why the old single-call 70-scene enrichment risk is gone.

**Editorial pass removed.** Its jobs live in the act-writer's continuity instruction + the validator. If the pilot
shows weak act-seam continuity, add back a single whole-script pass that edits narration **and** visual terms
together (so they stay consistent) — placed after Assemble, before Validate.

---

## 5. Assemble Full Script (code)

Concat each act's `scenes` into one `scenes[]` (global `scene_index` already continuous), carry
title/hook/outro_line/comment_hook/thumbnail_text/thumbnail_concept/seo_description/tags/caption_style, and append
the spoken outro scene (kinetic_text card, `is_outro: true`, narrated by the same TTS) exactly as Shorts does.

---

## 6. Validate Final Script (widened gates, tags errors with `.stage`)

- scene count ≥ 20 (warn > 70); **removed the 4–8 cap**.
- word count 1,000–1,800; **hard-fail > 2,000** (replaces the ≤280 cap). → `.stage = "structure"`.
- per scene: `point` + `narration` present; `search_terms` (3–6), `fallback_terms` (2–4), non-empty `visual_style`
  → missing/abstract → `.stage = "structure"`.
- **no-readable-text regex** on `search_terms`/`fallback_terms` (blocks the Fal garbling failure). → `.stage = "structure"`.
- medical keyword backstop on hook/title/narration → `.stage = "topic"`.
- dropped for MVP: dedup/diversity check.
- append-outro already done in Assemble.

---

## 6c. Fal image generation — three-step failure ladder (never fails the run)

Prompt: `"{house-style prefix} " + search_terms.join(", ") + ", " + visual_style + ". No text, no words, no letters, no logos, no watermark."`

1. **Primary** — from `search_terms`.
2. **Fallback** — on Fal error / empty / safety-block, regenerate once from `fallback_terms`.
3. **Placeholder** — else a house-style gradient still from `motion-assets/backgrounds/`, Ken-Burns'd for the
   scene duration. Video stays complete + audio-synced; scene logged as **degraded**.

Kill metric split: **hard run failure** = no video produced (the ">20% pipeline failure" trigger);
**degraded-scene rate** = placeholders ÷ scenes (>~10% = broken-looking, soft-fail for the pilot gate).

---

## 7. Compose edits (in long-compose/compose.js — two only)

1. **Scene concurrency cap.** Replace the unbounded `Promise.allSettled(scenes.map(...))` with a bounded pool
   (env `COMPOSE_CONCURRENCY`, default 3). At 40–50 scenes × 6000px zoompan the current code OOMs the 6GB box.
   Also lower the Ken-Burns upscale `scale=-2:6000` → ~3500 for long-form.
2. **Poll budget.** Workflow-side: `If Under Max Poll Attempts` 40 → ~120, `Wait Before Poll` 8s → 15s (~30 min).

Plus a small addition (not an "edit"): compose renders the **thumbnail PNG** from the passed thumbnail image +
`thumbnail_text` via a Remotion `Thumbnail` comp, and returns its path alongside the video (§11). No `/compose-long`.

---

## 8. TTS continuity

ElevenLabs `/with-timestamps` per scene, adding `previous_text` (prior scene narration) and `next_text` (next scene
narration) — stateless, parallel-safe prosody continuity across ~40–50 calls. `buildGaplessVoice` still does the final
sample-accurate join + single loudnorm.

---

## 9. Run-log record (Log Run → new `/run-log` on long-compose, appended to long_data)

```json
{
  "run_id": "uuid", "timestamp": "iso", "niche": "geography|historical_mysteries", "topic": "string",
  "script_word_count": 0, "num_scenes": 0, "num_images": 0, "script_attempts": 1,
  "fal_fallback_uses": 0, "degraded_scenes": 0, "render_time_sec": 0,
  "claude_input_tokens": 0, "claude_output_tokens": 0, "elevenlabs_chars": 0, "fal_calls": 0,
  "est_cost_usd": 0.0, "video_id": "youtube id (filled post-upload)"
}
```
Claude tokens summed from each response `usage`; est_cost from rates in config (Opus 4.8 $5/$25, Sonnet 5 $2/$10 intro,
Fal ~$0.04/img). The instrument the A/B test reads — join `video_id` to 28-day CTR/retention later.

---

## 10. Retry (single-path)

On validation failure, `Increment Attempt` → `If Under Max` (<3) → back to **Stage A (Blueprint+Topic)**, feeding
`lastErrors` into the prompt so the retry differs (*"previous attempt failed: {errors} — fix these"*); the failed topic
is already excluded via history. After 3 attempts → `Fail` (don't post a bad video). Record `script_attempts`.

(Routed per-stage retry was dropped for MVP simplicity — with 2 stages a full retry is cheap (~$0.6–1). If the pilot
shows frequent structural failures, re-introduce a Stage-B-only retry.)

---

## 11. Thumbnail (primary-metric node — built and pilot-tested)

CTR is a primary decision metric and auto-frame biases against Historical Mysteries.
**A/B-validity rule: identical template for both niches** — only the background image and `accent` color differ.

- Blueprint (§3) emits `thumbnail_text` (≤5 words) + `thumbnail_concept` (single 16:9 subject, no text/faces).
- **Fal: Thumbnail Image** — a dedicated **landscape 1280×720** generation from `thumbnail_concept` + house style
  (scene 0 is 9:16, so generate a real 16:9 frame, don't crop). Same failure ladder as §6c.
- **Render** — `long-compose` renders the PNG via a Remotion `Thumbnail` comp (Inter-Black text over a bottom
  gradient on the image, `accent` color), returned alongside the video (folded into compose — no extra n8n node).
- **Set Thumbnail** — after upload, `POST .../thumbnails/set?videoId=...` with the PNG. ⚠️ **Requires a
  phone-verified channel** — else 403 → silent auto-frame, re-introducing the bias. Verify before the pilot.

---

## 12. First pilot pre-checks

- Per-act visual JSON is small/reliable now (enrichment folded into Stage B), so the old 70-scene single-call risk
  is gone — but still eyeball act 1's output once.
- Confirm channel phone-verification (thumbnails).
- Run the 3-video pilot on the full pipeline (incl. thumbnails); gate on retention curve + no systematic Fal
  text-garbling + reliable end-to-end renders before the 30-video A/B.
