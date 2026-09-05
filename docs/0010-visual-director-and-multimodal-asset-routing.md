# RFC 0010: Visual Director and Multimodal Asset Routing

- **Status:** Implementing
- **Date:** 2026-09-05
- **Builds on:** RFC 0008, RFC 0009
- **Objective:** Make every visual beat explain, intensify, or emotionally support the exact narration being heard, while maintaining enough visual novelty to hold attention.

## Context

The long-form pipeline now has capable scripting, voice-over, rendering, captions, packaging, quality gates, and analytics infrastructure. Repeated output reviews show that the remaining product-level failure is narrower: the viewer is too often shown an image, diagram, or motion element that is only loosely related to the sentence being spoken, or is semantically correct but visually uninteresting.

More renderer features do not solve this. RFC 0010 therefore freezes unrelated production work and treats visual selection as the primary optimization problem.

The governing principle is:

> **For each 2–6 second narration beat, decide first what the viewer must see to understand the beat, then decide the most interesting truthful way to show it.**

This RFC supersedes RFC 0008's assumption that hand-drawn illustrated stills should be the default visual representation. RFC 0008's single-narrator/no-host simplification remains. RFC 0009's package, hook, hero-beat, watchability, QA, and analytics objectives remain.

## Decision 1: `visual_beat_plan` is the visual source of truth

The Visual Director consumes the full script and optional growth package and emits immutable `visual_beat_plan` artifacts. Beats are normally 2–6 seconds and are intentionally smaller than narration scenes when the visual information needs to change inside a scene.

Each beat records:

- exact narration and neighbouring context;
- semantic purpose and viewer takeaway;
- emotional intent and importance;
- required entities/actions/states;
- forbidden or misleading imagery;
- preferred and fallback visual modes;
- continuity group and entity ids;
- novelty requirement and requested change strength;
- concrete asset query/prompt and composition guidance.

The director must answer two independent questions:

1. **Semantic:** what must be visible for the viewer to understand this narration?
2. **Retention:** what is the strongest non-misleading way to show it?

A beautiful but irrelevant visual fails. A literal but generic visual also fails.

## Decision 2: route by visual job, not by a global house style

The supported modes are:

| Mode | Use when |
|---|---|
| `stock_video` | Authentic real-world footage exists and action/environment matters |
| `generated_image` | Historical, conceptual, narrative, emotional, or cinematic scenes need a specific composition |
| `motion_graphic` | Numbers, comparisons, maps, timelines, cause/effect, processes, labels, or transformations are the explanation |
| `generated_video` | Hook, reveal, climax, transformation, or another high-value beat materially benefits from real motion |

Generated video is an escalation, not a default. If it is unavailable, the beat falls back to an approved alternate mode.

Procedural/cartoon rendering is retained only where it is structurally strong: charts, timelines, maps, comparisons, arrows, labels, processes, and deterministic transformations. It must not be forced to portray complex historical environments, crowds, nuanced human emotion, natural landscapes, or cinematic physical scenes.

## Decision 3: fal.ai owns image generation

Image generation is direct through fal.ai. FreeLLMAPI image generation is removed from the Long project because its image quality, quota behaviour, and lack of reference-conditioned continuity make it unsuitable for the production target.

Provider boundary:

```text
TEXT_PROVIDER=freellmapi
TEXT_MODEL=gemini-2.5-flash

IMAGE_PROVIDER=fal
IMAGE_MODEL=fal-ai/flux-2 (configurable)
```

FreeLLMAPI remains a text/reasoning route and may remain a speech route where configured. It is not an image provider and must not be an image fallback.

For text, production may not use FreeLLMAPI `auto`, `auto:*`, or another implicit routing profile. A concrete Google Gemini model is pinned. If the configured model is invalid or unavailable, the request fails or uses the explicitly configured paid fail-open; it must not silently degrade to a weaker FreeLLM text model.

## Decision 4: actual visual content must be verified

Asset metadata, search terms, provider descriptions, and thumbnails are not sufficient evidence of semantic match.

Before a retrieved stock clip can be accepted, the resolver must inspect representative frames from the candidate segment and judge them against the beat contract. The judge scores at least:

- semantic match;
- required action/state match;
- visual interest;
- continuity with adjacent beats.

It also identifies the best in/out segment rather than accepting a whole source clip blindly.

The acceptance floor for the benchmark is:

```text
semantic_match >= 0.90
visual_interest >= 0.80
```

A stock candidate below the semantic floor is rejected, not used as filler. The resolver retries a materially different query and then falls back to generated imagery or a deterministic motion graphic. Unverified stock is never preferable to a semantically controlled generated asset.

Generated images continue to receive image QA for visible text, contradictions, artifacts, and sequence continuity.

## Decision 5: novelty is a deterministic constraint

Relevance alone is not sufficient. A sequence of perfectly relevant but compositionally identical generated stills is monotonous.

The resolver therefore examines the recent 20–30 seconds and flags repeated:

- visual mode;
- shot scale/composition;
- camera treatment;
- subject placement;
- explanatory pattern.

A beat with `novelty_required=true` should use a viable fallback representation when the preferred representation would create excessive repetition. Novelty never overrides semantic correctness.

## Decision 6: workers do not invent semantics

RFC 0003 remains strict:

- the Visual Director agent decides meaning, representation intent, and fallback order;
- workers retrieve/generate/render assets according to that contract;
- deterministic routing policy can reject unavailable, invalid, repetitive, or below-threshold candidates, but it does not reinterpret the narration.

All outputs remain immutable, versioned artifacts.

## Decision 7: benchmark before production graph replacement

RFC 0010 is deliberately developed as an isolated visual subsystem first. The existing production graph remains the control until the subsystem passes a comparison episode.

Benchmark input:

- one existing strong script;
- its existing voice-over;
- approximately 90–120 seconds of material.

Benchmark path:

```text
script
  -> visual_director
  -> visual_beat_plan
  -> multimodal asset resolver
  -> visual timeline
  -> simple comparison render
```

During this benchmark, do not improve scripts, captions, SFX, thumbnails, publishing, or unrelated renderer features.

## Acceptance criteria / kill gate

Against the current pipeline, the RFC 0010 comparison must achieve:

| Metric | Requirement |
|---|---:|
| Narration-to-visual semantic match | >= 9/10 |
| Visual interest | >= 8/10 |
| "Why am I seeing this?" failures | 0 |
| Repetitive visual patterns | <= 10% |
| Continuity errors | 0 |
| Generic filler B-roll | <= 5% |

If the subsystem cannot achieve these thresholds on the comparison episode, further investment in renderer sophistication is stopped. If it does, the RFC 0010 path replaces the current visual-direction/asset portion of the production graph in a follow-up graph version.

## Explicitly frozen work

Until the benchmark passes, do not spend implementation effort on:

- new caption styles;
- new SFX density or libraries;
- additional cartoon character presets;
- renderer DSL expansion unrelated to RFC 0010 representations;
- thumbnail experimentation;
- upload/publishing changes;
- new analytics dimensions;
- new script-generation features.

Bug fixes that are necessary to run the benchmark are allowed.

## Initial implementation boundary

This RFC's first implementation introduces:

1. `visual_beat_plan@1.0.0` and `visual_director@1`;
2. deterministic routing/novelty/candidate-selection policy;
3. fal-only image generation in Long;
4. pinned Google model for FreeLLMAPI text generation;
5. removal of FreeLLMAPI image configuration and provider selection;
6. a benchmark graph/harness that does not alter the production graph.

Stock-video frame verification and generated-video escalation are production-enabled only after their candidate verifier exists. Until then, those preferred modes must fall back; they may not bypass the semantic gate.

## Consequences

The system becomes less visually uniform but more semantically intentional. Some beats will be realistic, some generated, and some deterministic graphics. That is acceptable: representation is selected for the narration's job rather than to satisfy a global style constraint.

The production architecture also becomes easier to reason about. Image generation has one provider path (fal.ai), text has a pinned FreeLLMAPI Google model, and unsupported visual modes fail closed to declared fallbacks rather than entering the timeline as generic filler.