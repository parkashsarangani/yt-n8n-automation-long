# RFC 0010: Visual Director and Multimodal Asset Routing

- **Status:** Implemented; rendered comparison must pass before production migration
- **Date:** 2026-09-05
- **Builds on:** RFC 0008, RFC 0009
- **Objective:** Make every visual beat explain, intensify, or emotionally support the exact narration being heard, while maintaining enough visual novelty to hold attention.

## Context

Repeated output reviews isolated the remaining product-level weakness: narration can be good while the viewer is shown something only loosely related, generic, repetitive, or semantically correct but visually uninteresting. More renderer features do not solve that.

RFC 0010 therefore freezes unrelated work and makes visual relevance + visual interest the optimization target:

> **For each semantic narration beat, decide what the viewer must see, then choose the most interesting truthful representation, verify the actual pixels, and reject weak filler.**

RFC 0008's single-narrator/no-host simplification remains. RFC 0009's package, hook, watchability, QA and analytics objectives remain. The existing `illustrated_story` graph remains the production control until this RFC passes its rendered benchmark.

## End-to-end decision

```text
existing approved script + existing voice + existing production render
  -> full-script Visual Director
  -> 2-6s semantic VisualBeats
  -> measured ElevenLabs timestamp alignment
  -> visual-job router
  -> 3-5 agent-authored candidate strategies
  -> retrieve/generate candidates
  -> actual-frame multimodal QA
  -> best accepted candidate + exact video in/out
  -> 20-30s novelty controller
  -> audio-aligned visual timeline
  -> existing long-compose/Remotion renderer
  -> rendered-frame QA with previous/next visuals
  -> blind control-vs-V2 comparison
  -> executable PASS/FAIL kill gate
```

## 1. `visual_beat_plan` is the visual source of truth

The Visual Director reads the full script and the already-generated voice artifact. It uses the whole script as narrative context but emits only a contiguous opening benchmark window of complete narration scenes: target >=90 seconds and <=120 seconds when a complete-scene boundary permits it. It never cuts a narration scene merely to hit a clock target.

Each `VisualBeat` records:

- exact contiguous narration text and neighbouring context;
- semantic purpose, information, emotion, importance and viewer takeaway;
- concrete required entities/actions/states;
- forbidden/generic/misleading imagery;
- preferred and fallback visual modes;
- image style (`realistic`, `illustration`, or not applicable);
- stable continuity group/entity ids;
- novelty requirement and change strength;
- composition, camera treatment, subject placement and explanatory pattern;
- 3-5 materially different stock queries;
- 3-5 materially different generated-image concepts;
- generated-video motion prompt;
- deterministic motion-graphic brief.

The director answers two independent questions:

1. **Semantic:** what must be visible for this narration to make immediate sense?
2. **Retention:** what is the strongest truthful way to show it now?

Workers do not invent alternative meanings. Candidate diversity is authored by the agent, while workers retrieve/generate/score those declared alternatives.

## 2. Route by visual job, not by a global cartoon style

| Mode | Use when |
|---|---|
| `stock_video` | Authentic real-world footage exists and action/environment matters |
| `generated_image` | Historical, conceptual, narrative, emotional, cinematic or otherwise specific imagery is needed |
| `motion_graphic` | Numbers, scale, comparisons, maps, timelines, cause/effect, processes, labels or transformations are the explanation |
| `generated_video` | Hook, reveal, climax, turn or transformation materially benefits from real motion |

Procedural rendering remains for things it does well: maps, timelines, scale comparison, process/flow, labels and deterministic transformations. Complex historical environments, crowds, nuanced human emotion, landscapes, machinery and cinematic physical scenes are not forced into generic cartoon boxes.

Motion-graphic beats map into the existing semantic Remotion renderer (`map`, `timeline`, `scale-comparison`, `flow-system`, `animated-statement`) rather than creating another animation DSL.

## 3. Provider boundary

```text
TEXT / REASONING
FreeLLMAPI -> concrete Google model: gemini-3.5-flash
(no auto/auto:* production text routing)

IMAGE GENERATION
fal.ai -> FLUX.2 / configured fal image model
(no FreeLLMAPI image generation or image fallback)

PREMIUM TEXT-TO-VIDEO
fal.ai -> FAL_TEXT_TO_VIDEO_MODEL
(default: Kling 2.5 Turbo Pro text-to-video)

STOCK VIDEO
Pexels -> candidates only; no metadata-only acceptance

NARRATION
ElevenLabs existing production voice path
```

`FAL_TEXT_TO_VIDEO_MODEL` is deliberately separate from long-compose's older `FAL_VIDEO_MODEL` image-to-video contract.

FreeLLMAPI may still serve multimodal QA. It does not generate images.

## 4. Voice timing is measured, not guessed

Visual Director beat seconds are provisional. Before asset resolution, the benchmark reads each voice clip's ElevenLabs character alignment artifact and maps every beat's exact narration phrase onto measured timestamps.

Rules:

- beat narration must be an exact sequential phrase from the voice transcript;
- paraphrases fail closed rather than receiving guessed timing;
- first beat starts at scene 0;
- each beat ends at the actual start of the next phrase;
- the last beat ends at the measured voice-clip duration;
- the final timeline rejects gaps, overlaps and uncovered trailing narration.

Asset duration, stock windows, generated-video duration and render timing therefore use real narration timing.

## 5. Candidate generation and verification

### Generated images

For an image beat, the resolver generates 3-5 agent-authored concepts through fal.ai. Every candidate is checked for:

- accidental readable text;
- narration contradiction;
- semantic match;
- required action/state match;
- visual interest;
- continuity against the preceding selected visual;
- generic filler;
- "why am I seeing this?" failure.

Only candidates clearing every hard floor enter ranking. A pretty but semantically weak image cannot win.

### Stock video

For each of 3-5 materially different queries:

1. retrieve up to five Pexels source clips;
2. generate overlapping candidate windows across each source clip;
3. sample actual frames from each window with FFmpeg;
4. judge those frames against the VisualBeat contract;
5. reject generic/irrelevant windows;
6. if the query yields nothing admissible, move to the next materially different query;
7. rank accepted windows;
8. cut the exact winning source in/out segment with FFmpeg.

A Pexels title, tag, thumbnail or API search match is never sufficient evidence.

### Generated video

Premium generated video is restricted to `hero_role` or high-importance beats. Up to three candidates are generated through fal text-to-video, sampled as actual frames, VLM-scored and ranked. If no candidate clears the gate, only the Visual Director's declared fallback may be used.

## 6. Hard candidate floors

```text
semantic_match >= 0.90
action_match   >= 0.70
visual_interest >= 0.80
continuity     >= 0.70
```

In addition, `generic_filler` and `why_failure` must both be false.

The ranking weights only already-admissible candidates:

```text
semantic match  45%
action match    20%
visual interest 20%
continuity      15%
```

## 7. Novelty controller uses the preceding 20-30 seconds

The deterministic resolver keeps a rolling ~25-second history and checks:

- visual mode;
- composition / shot grammar;
- camera treatment;
- subject placement;
- explanatory pattern.

When a beat declares `novelty_required=true` and its preferred representation would continue a strong repetition pattern, the resolver may select only the agent-declared fallback, and only when that fallback remains available and is less repetitive. Novelty never overrides semantic correctness.

## 8. Visual timeline and renderer

`visual_timeline@1.0.0` is the render-ready contract. Every beat has:

- measured scene-relative audio window;
- absolute episode start/end;
- original immutable voice source;
- resolved visual mode;
- selected image/video or semantic Remotion template;
- narration/takeaway;
- continuity metadata;
- composition/camera/placement/pattern.

The benchmark renderer slices the immutable existing voice per beat, maps each beat to an existing long-compose scene and renders with the same production Remotion/FFmpeg service. Placeholder/degraded scenes are forbidden.

The benchmark does not introduce a second renderer and does not modify the production graph.

## 9. Final rendered-pixel QA

Candidate QA is necessary but not sufficient: crop, template rendering, timing or adjacency can still damage a good source asset. Therefore the final candidate MP4 is sampled again.

For each beat, the VLM receives:

- three chronological frames from the actual rendered beat;
- the preceding rendered visual;
- the following rendered visual;
- exact narration and semantic contract.

It re-scores semantic match, action, visual interest and continuity, and explicitly flags generic filler, "why am I seeing this?" failures and visual repetition.

## 10. Blind control-vs-V2 comparison

The benchmark also samples the same timestamps from the existing production/control render. Per beat, control and V2 are deterministically shuffled into anonymous A/B positions before the VLM comparison. The evaluator is not told which system produced either option.

The blind comparison records V2/control wins and semantic/interest scores, but relative improvement cannot compensate for absolute V2 quality failure. "Better than the old version" is not enough.

## 11. Executable kill gate

The benchmark report uses final rendered pixels and passes only when all original targets hold:

| Metric | Requirement |
|---|---:|
| Narration-to-visual semantic match | every beat >= 0.90 |
| Visual interest | every beat >= 0.80 |
| "Why am I seeing this?" failures | 0 |
| Repetitive visual patterns | <= 10% |
| Continuity errors | 0 |
| Generic filler B-roll | <= 5% |

The implementation intentionally uses the minimum semantic/interest score rather than an average so a few incoherent beats cannot be hidden by strong surrounding shots.

If the benchmark fails, production visual direction remains unchanged. If it passes, migration into the production graph is a separate follow-up change.

## 12. How to run the benchmark

Use artifacts from an existing completed episode:

```bash
cd engine
npm run visual:benchmark -- \
  <script-artifact-id> \
  <voice-artifact-id> \
  <control-rendered-video-artifact-id>
```

Required live capabilities are fal.ai, Pexels, the existing long-compose renderer and a reasoning/VLM route. The command never publishes. It outputs the V2 `rendered_video` artifact and `visual_benchmark_report`, and exits non-zero when the kill gate fails.

## Explicitly frozen until benchmark PASS

Do not spend implementation effort on:

- new caption styles;
- SFX density/libraries;
- additional cartoon character presets;
- unrelated renderer DSL expansion;
- thumbnail experimentation;
- upload/publishing changes;
- new analytics dimensions;
- new script-generation features.

Only defects required to execute or correctly evaluate RFC 0010 are in scope.

## Consequences

The video becomes intentionally hybrid rather than uniformly cartoon-based. Authentic footage is used when reality matters, fal-generated imagery when specificity/composition matters, semantic Remotion graphics when explanation structure matters, and premium generated video only where motion earns its cost.

The core rule remains simple: **the viewer must see the right thing at the right moment, and the system must verify that from actual pixels rather than assuming it from metadata or prompts.**
