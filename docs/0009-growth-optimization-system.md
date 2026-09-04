# RFC 0009: Growth Optimization System

- **Status:** Implemented; current-head CI verification pending
- **Date:** 2026-09-03
- **Implementation PR:** #220 (`feat/rfc-0009-growth-optimization`)
- **Builds on:** RFC 0008 (`0008-illustrated-story-format.md`)
- **Objective:** Maximize channel growth rate by optimizing what viewers choose, watch, finish, and continue watching — not by adding more rendering complexity.

> Verification note (2026-09-04): this documentation-only synchronization commit exists solely to force current-head PR verification after the implementation/test migration pass. It must not be interpreted as evidence that CI passed.

## Context

RFC 0008 deliberately simplified the product to a single-narrator illustrated-story format. That decision removed a large semantic/motion-graphics stack that was technically sophisticated but repeatedly produced output that was correct, valid, and not compelling enough to watch.

The current architecture is now simple enough that the next gains should come from editorial selection, packaging, retention-oriented story structure, shot density, visual QA, and a real analytics feedback loop.

The governing principle of this RFC is:

> **The pipeline should optimize audience response before it optimizes production sophistication.**

This RFC does **not** replace RFC 0008. It defines how the illustrated-story format should evolve if the operator's primary goal is to grow the YouTube channel as quickly as possible.

## Implementation contract for PR #220

The implementation branch `feat/rfc-0009-growth-optimization` is intentionally broad: the operator requested that the whole RFC be implemented together and reviewed as one coherent architecture change. Each decision below therefore has a concrete contract, graph, worker, prompt, storage, or policy change in the PR. Capabilities that depend on an external platform feature that is not exposed by the current provider API are represented as durable artifacts/metadata rather than falsely claimed as automated.

The implementation preserves RFC 0008's core format: single narrator, illustrated shots, deterministic camera/edit motion, no return to the retired semantic-diagram or host/lip-sync stack.

The RFC 0009 production path uses breaking v2 contracts for the changed direction, creative-review, analytics-memory, and multi-shot asset interfaces. Historical/manual v1 artifacts remain readable where required, but new production does not masquerade breaking shape changes as minor-version compatibility.

## Decision 1: Select a video package, not merely a topic

Discovery must stop treating the topic as the unit of selection.

Every candidate should be a complete audience proposition containing at least:

```text
premise
target_audience
curiosity_gap
emotional_engine
title_concepts[]
thumbnail_concepts[]
opening_visual
opening_line
clickability_score
story_potential_score
audience_size_score
```

Generate a broad candidate pool (target: 20–30 candidates per discovery cycle), rank the complete package, and only send the strongest few into story generation.

A topic that is intellectually good but does not naturally produce a strong title, thumbnail, hook, and emotional engine should be discarded before production spend begins.

### Acceptance signal

No production run begins from a bare topic string alone. The selected input already contains a defensible packaging concept and opening promise.

## Decision 2: Design title, thumbnail, and the first 30 seconds as one contract

Packaging must no longer be an independent downstream concern.

The title/thumbnail promise should be established before the final script, and the first 30 seconds must explicitly fulfill and intensify that promise.

Recommended structure:

```text
title + thumbnail promise
        ↓
0–5s: immediate tension / unanswered question
        ↓
5–15s: escalation, contradiction, or surprising context
        ↓
15–30s: second revelation / complication / stakes increase
```

Reject intros that spend the first 20–30 seconds establishing neutral context.

### Acceptance signal

A reviewer should be able to see the selected title/thumbnail, watch only the first 30 seconds, and say that the opening clearly delivers the promise that caused the click.

## Decision 3: Decouple narration scenes from visual shots

A narration scene is a writing unit. It must not remain the fundamental editing unit.

One narration scene may require multiple visual shots. A 9-second narration beat, for example, may become:

```text
0.0–3.0s   wide/context shot
3.0–5.8s   close/detail/reaction shot
5.8–9.0s   consequence/reveal shot
```

The director should decide the required number of shots from beat intensity and duration rather than assuming one generated still per script scene.

This is the preferred way to increase perceived motion and editing energy without introducing a full AI-video generation dependency.

### Acceptance signal

Long narration beats no longer create long stretches where a single still image is merely zoomed or panned for the entire duration.

## Decision 4: Add a visual-change budget, not just camera-move variety

`push-in`, `pull-out`, `pan-left`, `pan-right`, and `hold` are insufficient as the main variety mechanism. Different camera transforms over similar images still look repetitive.

Every generated shot should also have a semantic shot function, such as:

```text
wide
medium
close-up
object-detail
reaction
environmental-consequence
reveal
scale-shot
point-of-view
silhouette
location-before-after
```

The director should vary shot function and framing across consecutive shots. As a default constraint, do not allow three consecutive shots with the same shot function or substantially equivalent composition.

### Acceptance signal

A muted contact sheet should visibly change in scale, subject emphasis, and composition even before camera motion is considered.

## Decision 5: Spend more attempts on hero beats

Not all images are equally valuable.

Before image generation, identify 3–5 hero beats, normally including:

- the hook,
- first major escalation,
- low point,
- turn/reversal,
- payoff.

Normal connective shots may use one generation plus the existing retry path. Hero beats should generate multiple candidates and select the strongest one through multimodal ranking.

Recommended initial policy:

```text
normal shot: 1 candidate + existing QA retry
hero shot:   3 candidates → visual ranker → best candidate
thumbnail:   4–6 candidates → packaging ranker / YouTube experiment
```

### Acceptance signal

The most important visual beats receive intentionally higher generation spend than transitional material.

## Decision 6: Add an episode-level multimodal visual critic before final render

Because the illustrated images are load-bearing, per-image checks for visible text or narration contradiction are not enough.

After scene images are generated, assemble a contact sheet or ordered low-resolution preview and run one episode-level multimodal review.

The critic should score only viewer-relevant dimensions:

```text
opening_visual_strength
scene_relevance
subject_legibility
emotional_readability
shot_variety
visual_redundancy
continuity
style_consistency
ai_artifacts
payoff_visual_strength
```

The critic should identify specific scene indices to regenerate, not trigger a blind full-episode reroll.

This must remain one compact visual review layer. Do not recreate the retired multi-agent semantic QA hierarchy.

### Acceptance signal

The system can catch "all scenes are individually valid but the episode visually repeats itself" before final rendering.

## Decision 7: Make topic abandonment a normal unattended outcome

The system must not assume that every selected idea deserves a completed upload.

The current best-of-N script behavior is directionally correct, but selecting the best of several weak scripts is not sufficient.

Recommended policy:

```text
generate N serious script attempts
        ↓
select best
        ↓
meets watchability floor?
   yes → continue
   near miss → optional final targeted rewrite
   materially weak → abandon idea and select next candidate
```

Abandoning a weak idea is cheaper than generating voice, images, thumbnail, render, and publication assets for a story that should never have shipped.

The production graph therefore contains an explicit creative-viability boundary before voice/image/render spend. `revise` remains eligible for the existing writing retry path; `abandon` parks that topic so the unattended growth scheduler can advance to the next ranked candidate. Render, infrastructure, and technical-QA failures do not authorize topic substitution.

### Acceptance signal

A failed creative search can terminate the topic cleanly and automatically advance to another ranked candidate without publishing below-bar content.

## Decision 8: Produce materially different title/thumbnail variants for experimentation

Every episode should leave production with three genuinely different packaging propositions, not synonym variants.

Recommended framing families:

```text
A: curiosity / unanswered question
B: emotional conflict / injustice
C: outcome / reversal / consequence
```

Example:

```text
A: The Mechanic Everyone Thought Was Useless
B: His Boss Threw Away His Tool. Then This Happened.
C: Everyone Laughed at the Quiet Mechanic — Until the Engine Failed
```

Where the channel/account supports YouTube title/thumbnail experiments, the pipeline should use them. Otherwise the alternatives should still be stored so later experimentation is possible.

### Acceptance signal

Alternative packages change the psychological reason to click rather than merely changing wording.

## Decision 9: Turn YouTube analytics into editorial memory

Published-video analytics must feed future discovery and story decisions.

For each episode, persist and compare at least the metrics that are actually available through the connected YouTube APIs/workflow, such as:

```text
impressions
click-through rate
packaging experiment winner
5-second retention
15-second retention
30-second retention
midpoint retention / average percentage viewed
average view duration
retention spikes
retention dips
likes per view
comments per view
subscribers gained
traffic source
```

Audience retention is queried through the official retention report shape when available. Unsupported/insufficient-data responses remain explicit unknowns rather than synthetic zeroes or synthetic passes. Derived 5/15/30-second values are carried into the performance window so the strategist can distinguish an opening-retention problem from a later pacing problem.

The strategic output must be causal/actionable editorial observations, not just metric summaries.

Bad:

> Drama videos score 0.73.

Useful:

> Workplace-underestimation stories are retaining materially better through the first 30 seconds; family-sacrifice setups repeatedly dip during long context sections around 15–30 seconds.

Those observations should alter candidate ranking, hook construction, pacing, and packaging in later runs.

### Acceptance signal

Discovery can explain why it is preferring a new candidate using patterns learned from real published episodes rather than only prompt priors.

## Decision 10: Narrow the channel's emotional promise during the learning phase

Do not treat `moral_story`, `drama`, `true_story`, and `short_story` as equally weighted random choices during early channel growth.

For the first approximately 30–50 uploads, favor a repeatable emotional promise so viewers and YouTube receive a coherent audience signal.

Recommended initial engine:

```text
injustice / underestimation
          ↓
escalation
          ↓
lowest moment
          ↓
competence / truth / sacrifice revealed
          ↓
reversal / vindication / consequence
```

Settings can vary — workplace, family, school, business, social situations — while the emotional contract remains recognizable.

Genre expansion should follow observed adjacent-viewer behavior, not architectural preference.

### Acceptance signal

A viewer who likes one early episode should have an obvious reason to click several others even when the setting changes.

## Decision 11: Optimize the CTA for session continuation

Generic spoken "like and subscribe" CTAs should not consume valuable story runtime by default.

The primary end-of-video action should be continuation into another relevant episode. The narration, final card, and end-screen choice should cooperate to create an open loop into the next video where appropriate.

Example pattern:

> "But this was not the strangest time everyone underestimated the wrong person…"

Then route directly to the most relevant follow-up episode.

Subscription/like prompts may still be used sparingly where they do not weaken the payoff.

### Acceptance signal

The outro is designed around `next_video_click` / session continuation rather than a generic platform CTA.

## Decision 12: Add generated video only to proven high-value moments

Do not replace the illustrated-story format with full AI video.

If retention evidence later shows that still-image calmness is a real bottleneck, add short generated-motion clips only to selected hero beats, initially:

```text
opening 2–3 seconds
central reversal
climax / payoff
```

This keeps generated video additive and bounded. The default remains illustrated shots plus deterministic editing/camera motion.

### Acceptance signal

AI video spend is tied to measured retention opportunities rather than used uniformly because motion seems more sophisticated.

## Decision 13: Freeze major architecture changes until real audience evidence exists

The previous system repeatedly redesigned architecture based on predicted viewer preferences. RFC 0008 is intentionally simpler and should now be allowed to generate evidence.

Do not rebuild the semantic/motion-graphics architecture or perform another format-level rewrite merely because a theoretical alternative seems better.

Before another major architecture pivot, gather a meaningful sample of real published episodes — target at least 10–20 under a reasonably stable format — and inspect:

- click-through rate and packaging results,
- first 5 / 15 / 30 second retention,
- major retention dips and spikes,
- average percentage viewed,
- session continuation / next-video behavior where measurable,
- visible repetition and slideshow complaints,
- AI artifact/continuity failure rate,
- cost per publishable episode.

Small targeted improvements and fixes based on concrete production failures remain encouraged. The freeze applies to speculative format rewrites, not evidence-based iteration.

### Acceptance signal

Every substantial architecture proposal cites real episode/analytics evidence showing the current format's specific limiting factor.

## Target architecture

The intended end state is:

```text
Audience analytics
      ↓
Idea + packaging tournament (20–30 candidates)
      ↓
Top candidate set
      ↓
Story/script attempts ×N
      ↓
Best package + best script
      ↓
First-30-second promise check
      ↓
Creative viability boundary
      ├─ abandon → next ranked package
      └─ continue
      ↓
Shot director
      ↓
1–3 illustrated shots per narration beat
      ↓
Hero-shot multi-generation
      ↓
Illustration generation
      ↓
Episode-level multimodal visual critic
      ↓
Targeted scene regeneration
      ↓
Voice + captions + edit
      ↓
Technical QA
      ↓
Three title/thumbnail propositions
      ↓
Publish / experiment
      ↓
Retention + CTR + satisfaction feedback
      └────────────→ future idea selection
```

## Implementation priority

PR #220 implements all thirteen decisions in dependency order:

1. package selection + first-30-second promise contract + three packaging variants;
2. multi-shot direction + visual-change budget + hero-beat designation;
3. multi-candidate hero generation + episode-level visual review + targeted regeneration;
4. topic abandonment instead of below-bar publication;
5. analytics-derived editorial memory + early-channel emotional focus + continuation CTA metadata;
6. bounded AI-video eligibility metadata, disabled unless audience evidence activates it;
7. architecture-freeze guardrails/documentation and regression tests.

## Verification contract

The PR is not reviewer-ready merely because the code paths exist. Before draft status is removed, the current head must pass the repository CI matrix: engine image build/typecheck/tests, compose/config contracts, Remotion typecheck/source contracts, motion render regression, and long-compose output-quality render tests. Any implementation claim in the PR description must be revised if current-head CI disproves it.

## Non-goals

This RFC does not:

- restore the retired semantic-diagram system,
- restore host characters or lip-sync,
- require full AI-generated video,
- add another chain of comprehension/factual-fidelity agents,
- claim that a specific genre or visual style will win before analytics demonstrates it.

## External rationale

These decisions are consistent with YouTube's current creator guidance emphasizing packaging, viewer choice, retention, satisfaction, and analysis of audience-retention spikes/dips rather than production complexity for its own sake:

- YouTube Help — recommendation/performance guidance: https://support.google.com/youtube/answer/16533387
- YouTube Help — audience retention: https://support.google.com/youtube/answer/9314415
- YouTube Help — title and thumbnail experiments: https://support.google.com/youtube/answer/16391400
- YouTube — recommendation system overview: https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/

The repo's own production evidence remains the primary authority for implementation decisions. External guidance informs what to measure; real channel data decides what to change.
