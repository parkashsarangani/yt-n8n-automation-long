# Long-form MVP — build spec (script-gen + enrichment)

Status: build spec for review. Flat model (1 scene = 1 beat = 1 TTS call = 1 Fal image = 1 alignment),
~40–50 scenes, ~1,200–1,500 words. Reuses the Shorts `/compose` service with two edits (see §7).
Visual source = Fal `flux/dev` (unchanged from Shorts; NOT Pexels).

Empirical placeholders pending channel data: view-count CV `TBD-from-channel-data`,
CTR viability floor `TBD-from-channel-data`. Decision metrics: CTR + avg-view-duration primary,
revenue/views landslide-only (see the A/B protocol in chat).

---

## 1. Node graph (`long-form.json`)

```
Trigger (Manual + Schedule ≤1/day)
  → Set Niche Param                     # {niche: "geography" | "historical_mysteries"}
  → Resolve Niche Config                # code: niche → {topicSeed, visualStyle, captionStyle, voiceId, tone}
  → Get Topic History (per-niche key)   # continueOnFail
  → Ensure Topics Array
  → Init Script Attempt Counter         # scriptAttempt = 0
  → Claude: Generate Topic              # Sonnet 5, niche-seeded
  → Extract Topic
  → Claude: Blueprint (Stage A)         # Opus 4.8 — title, hook, acts[], outro, SEO. small output
  → Parse Blueprint
  → Loop Over Acts (splitInBatches)     # body ↓ ; done → Assemble Full Script
        → Claude: Write Act (Stage B)   # Opus 4.8 — scenes for THIS act, carries blueprint + prior-act summaries
        → Parse + Accumulate Act
        → (loop back to Loop Over Acts)
  → Assemble Full Script                # concat act scenes → single scenes[] with global scene_index
  → Claude: Editorial Pass (Stage C)    # Sonnet 5 — continuity across act seams, word band, retention
  → Parse Editorial
  → Claude: Visual Plan Enrichment (D)  # Sonnet 5 — per-scene search_terms/visual_style/fallback_terms
  → Merge Enrichment into Scenes
  → Validate Final Script (widened)     # code: gates in §6b ; tags each error with .stage ; sets _scriptValid
  → If Script Valid
      TRUE → append spoken outro scene → Split Out Scenes  +  Save Topic to History (per-niche)
      FALSE → Route Retry by failure stage (§10):
                structural (editorial/enrichment) → re-run from Stage C  (does NOT re-run the Opus act loop)
                topic/medical                     → fresh topic (full restart)
                (each path feeds lastErrors into the re-run prompt; budgets in §10)
  → [parallel branches off Split Out Scenes]
        (audio) ElevenLabs TTS + prev/next_text  → Tag Audio       → Aggregate Audio
        (visual) Loop Scenes → If Template ? Tag Template : Fal Image (search_terms → fallback_terms → gradient placeholder, §6c) → Tag Image → Aggregate Visuals
  → Wait Both Branches → Merge by scene_index
  → Fal: Thumbnail Image + Build Thumbnail (§11)   # full pipeline incl. thumbnails runs in the pilot
  → Start Compose Job (/compose)         # unchanged endpoint; long payload
  → Poll (budget raised — §7)
  → Validate Compose → Download → YouTube Upload → Set Thumbnail (§11) → Disclose AI → Log Run → Cleanup
```

Dead node from Shorts (`Tag Video with scene_index`) is dropped.

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
  },
  historical_mysteries: {
    topicSeed: "historical mysteries — unexplained disappearances, lost places, unsolved events, famous figures with a hidden gap in the record. Recognizable names/events preferred.",
    visualStyle: "mysterious historical documentary, dramatic low-key lighting, aged and cinematic",
    captionStyle: "serious",
    voiceId: "UgBBYS2sOqTuMpoF3BR0",
    tone: "ominous, intriguing, story-driven",
  },
};
const niche = $json.niche;
const cfg = CONFIG[niche];
if (!cfg) throw new Error(`Unknown niche "${niche}" — must be one of ${Object.keys(CONFIG).join(", ")}`);
return { json: { niche, ...cfg } };
```

Per-niche topic-history key: pass `?niche=<niche>` to the history endpoint, or namespace the stored file.

---

## 3. Blueprint prompt (Stage A — Opus 4.8, adaptive thinking, effort high, ~2k out)

> You are the head writer for a long-form YouTube channel (8–10 minute videos) in the **{{niche}}** niche.
> {{topicSeed}}
>
> Given the topic below, design the video's SKELETON only — not the full script. Plan the ending first: decide the hook, the single payoff/kicker that ends the video, and one one-tap engagement question to weave in around the two-thirds mark.
>
> Structure: an intro hook (~30–40s) → **3–5 acts**, each escalating (BUT/THEREFORE, never AND-THEN) → a payoff → a short spoken outro (shares, not a repeat of the mid-video question). Each act must make the previous one matter more.
>
> HARD EXCLUSION: no medical/health topics.
>
> Output ONLY JSON: {"title": string (≤70 chars, stakes+emotion, withhold the resolution), "hook": string, "outro_line": string (8–16 words, drives shares), "comment_hook": string (one-tap question), "seo_description": string, "tags": [8–15 strings], "caption_style": "{{captionStyle}}", "acts": [{"act_index": number, "act_title": string, "premise": string (1–2 sentences — what this act reveals and how it raises the stakes), "target_words": number (~250–350)}]}
>
> Topic: {{topic}}

---

## 4. Act-writer prompt (Stage B — Opus 4.8, loop per act, ~2k out each)

> You are writing ONE act of a long-form {{niche}} video. Voice: {{tone}} — a smart friend telling a gripping story, reacting to the material, never a textbook.
>
> You are given the full blueprint and summaries of the acts already written. Write ONLY this act's scenes. Each scene = one narration beat of ~25–40 words (a few sentences), one visual. Every scene must re-hook: end on a micro-cliffhanger, a raised stake, or a question the next scene answers. No flat beat survives.
>
> This act must continue seamlessly from the prior acts (don't repeat what they covered; deepen it). Hit ~{{target_words}} words across this act's scenes. If this is the act containing the two-thirds mark, weave in the comment_hook question naturally.
>
> VISUAL RULES: for each scene give a `stock_search_query`-free `narration` plus nothing else visual — the visual plan is generated separately. Do NOT describe images here.
>
> Output ONLY JSON: {"act_index": {{act_index}}, "scenes": [{"scene_index": number (continue global numbering from {{next_scene_index}}), "point": string, "narration": string}], "act_summary": string (2 sentences, for the next act's context)}
>
> Blueprint: {{blueprint}}
> Acts already written (summaries): {{prior_act_summaries}}
> Write act: {{act}}

Loop mechanics: `Loop Over Acts` (splitInBatches) carries `blueprint`, accumulated `prior_act_summaries`,
and `next_scene_index`. Each iteration appends its scenes and its `act_summary`.

---

## 5. Editorial pass (Stage C — Sonnet 5, thinking off, ~7k out)

Same intent as the Shorts editorial node, retargeted: enforce the long-form word band (1,000–1,800; hard ceiling 2,000),
verify every act-seam carries BUT/THEREFORE tension, kill any flat middle stretch, confirm the video ends on the kicker
with the comment_hook woven in earlier (not at the end), medical backstop, and that narration contains no cues that would
force readable text in a generated image. Output the same JSON schema as assembled (title/hook/outro_line/comment_hook/
seo_description/tags/caption_style/scenes[]).

---

## 6. Visual Plan Enrichment (Stage D — Sonnet 5, dedicated node) — the Phase-2 piece

Input: the validated `scenes[]` (each `{scene_index, narration}`) + `niche` + `visualStyle`.
One call emits the visual plan for ALL scenes, using **structured outputs** (`output_config.format` with a
`json_schema` for `{visual_plan: [...]}`, `max_tokens` 8192) so the array is schema-valid and complete rather than
free-form-parsed. At 70 scenes the output is only ~4–5k tokens, well inside the ceiling — but see §12 for the empirical
check and the per-act chunking fallback if the pilot ever shows a truncated array.

Prompt:

> You generate the VISUAL PLAN for a {{niche}} video whose default style is "{{visualStyle}}". For each scene's narration, output concrete, generatable visual concepts for an AI image model.
>
> For each scene:
> - `search_terms`: 3–6 concrete, photographable subjects literally present in THIS scene's narration (name objects/places/actions — "roman legionary helmet", "misty highland valley", "aerial river delta" — never abstractions like "mystery" or "identity"). Must be visually DISTINCT from the adjacent scenes so the video never looks repetitive.
> - `visual_style`: a 2–4 word style for this beat (default to "{{visualStyle}}"; vary tastefully per act for texture).
> - `fallback_terms`: 2–4 broader backup subjects for when the primary generation fails or is blocked.
>
> Scene 0 is the thumbnail/first frame — make its terms the most striking, clearest single subject of the set.
> NEVER include readable text, numbers, documents, screens, UI, currency, logos, or faces of real named people in any term.
>
> Output ONLY JSON: {"visual_plan": [{"scene_index": number, "search_terms": [string], "visual_style": string, "fallback_terms": [string]}]}
>
> Scenes: {{scenes_narration_only}}

`Merge Enrichment into Scenes` joins `visual_plan` onto `scenes` by `scene_index`.

---

## 6c. Fal image generation — three-step failure ladder (never fails the run)

The Fal node builds the prompt:
`"{house-style prefix} " + search_terms.join(", ") + ", " + visual_style + ". No text, no words, no letters, no logos, no watermark."`

On failure it degrades, it does not abort:
1. **Primary** — generate from `search_terms`.
2. **Fallback** — on Fal error / empty / safety-block, regenerate once from `fallback_terms`.
3. **Placeholder** — if that also fails, use a house-style gradient still from `motion-assets/backgrounds/`
   (Ken-Burns'd for the scene duration). The video stays complete and audio-synced; the scene is logged as **degraded**.

Never fail the whole run on a single scene. This makes the kill metric measurable (see §9 / §13):
- **hard run failure** = no video produced (compose crash, upload fail) — this is the ">20% pipeline failure" trigger.
- **degraded-scene rate** = placeholders ÷ scenes, per video — a *separate* quality gauge; a video with >~10%
  placeholders looks broken and counts as a soft failure for the pilot gate.

---

## 6b. Validate Final Script (widened gates)

Changes from the Shorts validator:
- scenes count: **remove 4–8 cap** → require ≥ 20, warn if > 70.
- word count: **replace ≤280** → require 1,000–1,800, hard-fail > 2,000.
- keep: per-scene `point`/`narration` presence, medical keyword backstop, **no-readable-text regex on any visual field**.
- drop for MVP: dedup/diversity check (accept some repetition), medical exclusion can stay or go per your call.
- enrichment gate: each scene has `search_terms` (3–6), `fallback_terms` (2–4), non-empty `visual_style`.
- append spoken outro scene (unchanged mechanism).

---

## 7. Compose edits (in shorts-compose/compose.js — two only)

1. **Scene concurrency cap.** Replace the unbounded `Promise.allSettled(scenes.map(...))` with a bounded pool
   (limit 2–3, env `COMPOSE_CONCURRENCY`). At 40–50 scenes × 6000px zoompan the current code OOMs the 6GB box.
   Also lower the Ken-Burns upscale from `scale=-2:6000` to ~3500 for long-form to cut per-process RAM.
2. **Poll budget.** Workflow-side: raise `If Under Max Poll Attempts` from 40 to ~120 and `Wait Before Poll` to 15s
   (~30 min ceiling). Each poll still returns fast, so Cloudflare 524 stays solved.

No new `/compose-long` endpoint in the MVP.

---

## 8. TTS continuity

ElevenLabs `/with-timestamps` per scene, adding `previous_text` (prior scene narration) and `next_text` (next scene
narration) to each request body — stateless, parallel-safe, gives prosody continuity across ~40–50 calls without
request-stitching. `buildGaplessVoice` still does the final sample-accurate join + single loudnorm.

---

## 9. Run-log record (Log Run node → new `/run-log` on compose service, appended to shorts_data)

```json
{
  "run_id": "uuid", "timestamp": "iso", "niche": "geography|historical_mysteries",
  "topic": "string",
  "script_word_count": 0, "num_scenes": 0, "num_images": 0,
  "script_attempts": 1, "retry_stages": [],
  "fal_fallback_uses": 0, "degraded_scenes": 0,
  "render_time_sec": 0,
  "claude_input_tokens": 0, "claude_output_tokens": 0,
  "elevenlabs_chars": 0, "fal_calls": 0,
  "est_cost_usd": 0.0,
  "video_id": "youtube id (filled post-upload)"
}
```
Claude tokens summed from each response `usage`; elevenlabs_chars = sum of narration lengths; est_cost from rates in
config (Opus 4.8 $5/$25, Sonnet 5 $2/$10 intro, Fal ~$0.04/img, ElevenLabs plan rate). This is the instrument the A/B
test reads — join `video_id` to 28-day CTR/retention later.

---

## 10. Retry semantics (routed, not whole-pipeline)

The validator tags each error with `.stage`:
- `enrichment` — missing/short `search_terms`/`fallback_terms`, empty `visual_style`.
- `editorial`  — word count out of band (1,000–1,800; hard-fail >2,000), scene count <20, flat/structural.
- `topic`      — medical backstop, unverifiable/quality → the topic itself is the problem.

Router (`Route Retry by failure stage`):

| Failure stage | Re-run from | Re-runs the Opus act loop? | Cost |
|---|---|---|---|
| `enrichment` only | Stage D (enrichment) | no | ~1 Sonnet call |
| `editorial` / word / scene | Stage C (editorial) → D | no | ~2 Sonnet calls |
| `topic` / medical | fresh topic (full restart) | yes | full chain |

**Every retry feeds `lastErrors` into the re-run prompt** (answers #2 — attempts must differ or they fail identically):
- Editorial re-run: *"Your previous output was {N} words; target 1,000–1,800. {specific errors}. Fix only those."*
- Enrichment re-run: *"Scenes {ids} were missing fallback_terms / had abstract search_terms. Re-emit the full plan, fixing those."*
- Fresh-topic re-run: the failed topic is already excluded via history; also pass *"previous attempt failed because {reason} — avoid that."*

Budgets: structural retries capped at 2 (cheap), full restarts capped at 3, combined ceiling 4 → then `Fail` (don't post a bad video). Record `script_attempts` + `retry_stages[]` in the run log.

---

## 11. Thumbnail (spec'd to the same level as A–D — it's a primary-metric node)

CTR is a primary decision metric and auto-frame biases against Historical Mysteries, so this is built and pilot-tested.
**A/B-validity rule: identical template for both niches** — only the background image and the niche accent color differ,
never the construction — so the comparison isn't confounded by thumbnail *quality* varying by niche.

Blueprint (§3) gains two fields:
- `thumbnail_text`: ≤5 words, punchy, withholds the resolution (like the title). Rendered as the overlay.
- `thumbnail_concept`: one striking, single-subject visual for a 16:9 frame — **no readable text, no real faces** (same no-text rule as scenes).

Nodes:
1. **Fal: Thumbnail Image** — generate a **landscape 1280×720** image from `thumbnail_concept` + house style (scene 0 is portrait 9:16, so generate a dedicated 16:9 frame rather than crop). Same 3-step failure ladder as §6c (fallback concept → gradient).
2. **Build Thumbnail** — Remotion composition `Thumbnail` (reuses the existing Inter fonts + gradient assets): background image → bottom darkening gradient → bold `thumbnail_text` in Inter-Black, high contrast, niche accent color from Niche Config. Output 1280×720 PNG. (FFmpeg `drawtext` is the fallback if you'd rather not add a Remotion comp.)
3. **Set Thumbnail** — after upload, `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=...` with the PNG (YouTube OAuth already configured). ⚠️ **Custom thumbnails require a phone-verified channel** — confirm the channel is verified before the pilot, or this node 403s and every video silently falls back to auto-frame (which would quietly re-introduce the exact bias we're removing).

---

## 12. Enrichment batch-size — empirical check (do first in the pilot)

70 scenes × ~60 tokens ≈ ~4–5k output tokens, inside Sonnet 5's ceiling, and structured outputs (§6) guarantee schema
validity. I can't run it from here (no API access this session), so it's a **pilot pre-check**: run Stage D once on a
synthetic 70-scene payload and confirm the returned `visual_plan` has exactly 70 complete entries. If it ever truncates,
the documented fallback is **per-act enrichment** — call Stage D inside the existing act loop (~8–12 scenes/call, trivially
reliable), trading global cross-act distinctness for guaranteed completeness. Ship single-call; keep per-act in the back
pocket.
