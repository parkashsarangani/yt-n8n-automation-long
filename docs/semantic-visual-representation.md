# Semantic visual representation architecture

> **Superseded by [RFC 0008](0008-illustrated-story-format.md).** This document describes
> the semantic diagram system that RFC 0008 removes. Kept for historical context and because
> legacy artifacts produced under it remain resumable; do not build against it.

## Problem

Rendered-output audits exposed a structural limit in the explanation system: the planner/critic can detect a `generic-visual`, but the reviser is still constrained to the same abstract primitive grammar (`network`, `cause-chain`, `objects`, `nested-context`, etc.). A scene can therefore be correctly flagged as too abstract and still only be revised into a different generic diagram.

## Non-negotiable rule

Generic node/box/relationship diagrams are **not** a fallback for new semantic scenes.

If the system cannot produce a supported concrete/domain/quantitative/spatial representation, it falls back to a deliberate animated explanatory statement that communicates the main idea on screen. It must never invent arbitrary geometry merely because the planner produced nouns and relations.

Legacy versioned explanation artifacts remain renderable for resumability, but new plans use the semantic representation path.

## Representation hierarchy

Use the highest useful representation in this order:

1. concrete physical depiction;
2. domain-specific scientific/mechanistic model;
3. quantitative comparison;
4. spatial/cross-section representation;
5. timeline/map when that is genuinely the claim;
6. animated explanatory text when no supported visual representation earns the seconds.

AI editorial imagery remains a separate watchability/reset modality. It is not used to hide weak explanatory motion graphics.

## Planning contract

`explanation_plan@1.6.0` adds:

- `representation_mode`: `concrete-scene`, `domain-model`, `quantitative`, `spatial`, `kinetic-text`;
- `scene_blueprint`: reusable semantic renderer family;
- `visual_claim`: one proposition the scene must make visually true;
- `visual_actions[]`: actor/action/target/anchor-phrase instructions describing the state change during the spoken turn.

The previous primitive/operation metadata is retained for version compatibility and ancillary selection logic, but does not own production rendering for new semantic plans.

## Motion rule

Animate the mechanism, not the graphic.

Examples:

- ice cube: drop -> rise -> settle at surface;
- water molecules: slow -> orient -> bond -> rearrange;
- lattice: assemble -> open gaps -> expand occupied volume;
- lake cross-section: cool -> sink -> stratify -> freeze surface;
- equal mass comparison: preserve item count -> expand volume -> reveal lower density.

Unsupported semantic actions resolve to animated explanatory text, never random arrows or nodes.

## Voice alignment

A post-voice semantic timing worker resolves each action's `anchor_phrase` against ElevenLabs alignment and injects normalized timing windows into the renderer payload. If exact alignment is unavailable, deterministic ordered windows are distributed across the spoken turn instead of completing all motion at scene start.

## Renderer

Initial reusable blueprint families:

- `container-object`
- `molecular-system`
- `lattice`
- `cross-section`
- `mass-volume-comparison`
- `before-after-object`
- `animated-statement`

Unknown or insufficient blueprints dispatch to `animated-statement`, not `MotionDesignSystem` geometry.

## Storyboard review

New failure modes:

- `over-abstracted`
- `label-dependent`
- `missing-causal-action`
- `wrong-representation`
- `motion-without-information`

The decisive test remains: if changing only the labels would make the visual fit an unrelated topic, it is too generic.

Suggested fixes must name representation fields/blueprints/actions rather than merely swap one primitive for another.

## Release invariants

For new plans:

- every scene has a representation mode, blueprint and visual claim;
- non-text semantic scenes have at least one visual action;
- `kinetic-text` uses `animated-statement`;
- unsupported mode/blueprint combinations fail before render;
- flagged scenes must actually change;
- legacy relation-index validation remains intact.

## Benchmark gate

Before claiming finished-video quality improvement, render and inspect at least:

1. an ice/density/molecular-mechanism episode;
2. an onion/chemical-mechanism episode;
3. a quantitatively different episode such as million/billion/trillion.

CI proves contract integrity, not perceptual quality.
