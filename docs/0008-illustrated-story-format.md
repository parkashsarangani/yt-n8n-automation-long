# RFC 0008: Illustrated Story Format

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** `semantic-visual-representation.md`; the visual-planning half of RFC 0006

## Context

The pipeline reliably produces episodes that pass every contract and are not worth
watching. That is a statement about observed output, not a prediction.

Measured on real published renders:

- A 44-scene episode used the `before-after-object` blueprint for 37 scenes (84%). Every
  use was individually honest — each scene genuinely was a before/after state change — so
  every per-scene check passed. The viewer saw the same two labelled boxes for the entire
  runtime.
- In a 17-scene episode, characters appeared in scenes 0, 15 and 16 only. Fourteen
  consecutive scenes ran without them, comfortably inside the `<=35%` character ceiling,
  because that rule bounded character *overuse* and nothing bounded absence.
- AI image prompts were assembled from the diagram system's `model_elements` vocabulary.
  An episode about cats landing on their feet asked the image model for a "Linked Cylinder
  Model" undergoing "Rigid-Body Rotation". The word *cat* never reached the prompt as a
  subject. Roughly 250 of 2,431 prompt characters described what to draw; the rest was
  style boilerplate, hex palettes, both character bibles, and hash tokens
  (`entity-linked-cylinder-model-mhncrh uses #FF7D7D`) that mean nothing to an image model.
- The release gates enforced `factual_fidelity >= 0.92`, `comprehension >= 0.88`,
  `final_teach_back`, `short_line_ratio` and `physical_explanation_model`. These blocked
  nearly every run in a full working session. None of them measure whether a viewer keeps
  watching.
- One 189-second episode contained 41.7 seconds of near-silence across 82 pauses — 22% of
  runtime — because each line was treated as its own audiovisual unit.

The subsystems worked. The video did not.

## Problem

Two distinct questions had been collapsed into one: *is the output correct?* and *will
anyone watch it?* The system answered the first exhaustively and never asked the second.

This RFC settles what format the system produces, and what it is allowed to spend
complexity on.

## Decision

### 1. The format

Episodes are **single-narrator voice-over across sequential hand-drawn illustrations.**

There are no on-screen characters, no dialogue between hosts, no lip-sync. An episode opens
directly on the story. Motion comes from cuts and deterministic camera moves over stills.

### 2. Visual identity

The look is locked to hand-drawn pen-and-ink with a muted wash, following the reference the
format was chosen from:

- Human figures MUST be minimal and faceless — stick figures with simple clothing shapes.
- Environments, objects and animals MUST be rendered with real detail and texture. The
  contrast between abstract figures and a detailed world is the signature.
- Palette MUST stay muted and near-monochrome: sepia, ochre, dusty green, warm neutrals.
- Compositions MUST be wide, with the subject off-centre and real negative space.
- Visible paper grain MUST be applied uniformly to every image downstream, so shots read as
  one set rather than separate generations.

Style MUST be conditioned on reference plates, not described in prose. Prose style
descriptions drift between generations; reference images hold across an episode and across
episodes. Consistency across episodes is what makes the output a show.

Prompts MUST NOT request: photorealistic humans, glossy 3D, rim lighting, lens flare,
hyperreal skin, or centred symmetrical hero shots. These are the signature of saturated AI
output and are excluded explicitly rather than hoped against.

### 3. Pipeline

```
topic → story beats + narration → ONE gate
      → shot list (one illustration prompt per beat)
      → images + voice-over + captions
      → assembly → publish
```

### 4. The single gate

Exactly one gate, and it scores the script only: hook, escalation, the turn, the payoff,
watchability, and whether it is titleable. Nothing downstream blocks.

Retired: `factual_fidelity`, `comprehension`, `final_teach_back`, `short_line_ratio`,
`physical_explanation_model`, and the plan critic/reviser/release loop.

**Where watchability and technical correctness conflict, watchability wins.** Content must
still be true; it does not have to be complete, balanced, or pedagogically exhaustive.

### 5. Image prompts

Each prompt MUST name exactly one concrete, particular, physically depictable thing and what
it is doing — "a tabby cat mid-fall, back arched, front half already twisted toward the
floor". A prompt MUST NOT contain an abstraction, a diagram noun, a restatement of the
narration, or any request for text to be drawn. Style, palette and camera are applied
downstream and MUST NOT appear in the prompt.

### 6. Deleted

The semantic visual stack: `episode_visual_modeler`, `explanation_visual_planner`,
`explanation_plan_critic`, `explanation_plan_reviser`, `explanation_plan_release`,
`semantic_visual_assets`, the semantic renderer library, and the `explanation_plan`,
`episode_visual_model` and `visual_plan` schemas.

The character stack: `CartoonScene`, character rigs, cast roster, lip-sync, gestures, gaze,
backgrounds, props, the `cartoon-scenes-v8…v16` compiler chain, and the two-host dialogue
writer.

## Alternatives Considered

**Keep repairing the semantic diagram system.** Rejected. Several sessions of fixes —
blueprint-variety caps, character-reappearance floors, entity-grounded depiction — each
verified working, and the output was still not watchable. The defects moved; the result
didn't improve.

**Two hosts as A-roll with images as cutaway B-roll.** Seriously considered, and better than
the diagram system: it makes images non-load-bearing, so a weak generation costs a two-second
cutaway instead of a broken scene. Rejected because it retains the two hardest problems —
character consistency across generations, and lip-sync quality under constant scrutiny — and
because the chosen reference format has no characters at all.

**Blender plus text-to-3D motion (Kimodo, HY-Motion).** Rejected. Weeks of new
infrastructure — GPU rendering, a rigged character, a new asset pipeline — against tools
whose own documentation describes them as young or research-grade, with no evidence that
animation was the binding constraint rather than subject relevance.

**After Effects template library.** Rejected: requires a motion designer, which we do not
have.

**AI video / motion transfer (Kling, Wan2.2, Runway) for hero shots.** Deferred, not
rejected. It is additive to this format: a small number of generated clips can replace
individual stills later without changing anything else. Revisit once the still format is
proven.

## Consequences

**Easier.** About four moving parts instead of twenty. No character consistency problem, no
lip-sync, no layout collisions, no diagram geometry, no plan review loop. Faceless figures
and a near-monochrome palette are dramatically easier for an image model to reproduce
consistently than faced characters in fixed outfits.

**Harder, and accepted deliberately:**

- **Images become fully load-bearing.** In the A-roll/B-roll alternative a weak image was a
  cutaway; here it is the entire frame. The mitigation is that the style is far more
  reproducible and the subjects are concrete story beats rather than abstractions — but this
  is a real risk, accepted knowingly.
- **Quality moves almost entirely into the writing.** With no hosts and no animation, the
  hook, escalation and payoff are what hold a viewer. A weak script can no longer be
  rescued downstream.
- **No recurring-character identity.** Channel identity now rests on the art style, the
  narrator, and the point of view in the writing.
- **Visuals are calm.** Motion is cuts and camera moves. Mechanisms cannot be animated.
- **Mechanism-heavy topics get harder**, since nothing can be shown changing over time. Topic
  selection must favour subjects that read as story beats.

## Migration Strategy

No flag day. The illustrated-story format is a new graph; the existing `cartoon` graph and
its artifacts stay valid and resumable. Retired transformations and schemas remain in the
registry so historical artifacts continue to validate and replay. Nothing is deleted from
the artifact store.

## Addendum: genre and image style are operator-selectable, not fixed

The first two published episodes surfaced that a single fixed narrative shape and a single
fixed visual identity were both too narrow — real feedback asked for drama, true-story and
short-story content alongside the moral_story default, and for a second visual identity
(`flat_comic_expressive`, expressive faces) alongside the original faceless ink-wash. Both are
now `intent` fields (`genre`, `image_style`; see `schemas/intent/1.1.0.json`), selected per run
rather than hardcoded, and surfaced on the operator UI. `narrative_story_architect` and
`narration_script_writer` branch on `genre` (see their `@2` prompts); `illustrated_scene_assets`
branches on `image_style` (see `STYLE_BUNDLES`). Both are optional and default to the original
behavior when absent, so this is additive, not a rewrite of the decision above — the "no
characters, illustrated stills, one watchability gate" architecture is unchanged; only the
narrative shape and the art direction within it are now a choice instead of a constant.

## Open Questions

**Content genre.** Resolved differently than originally framed: rather than picking one shape
by argument or by retention data, genre is now an operator choice per run (see addendum above).
What remains open is which genre(s) actually retain and share best in practice — to be settled
by measurement across published episodes of each type, not by argument.

**Language and audience.** The reference channel publishes in Urdu/Hindi; this pipeline
currently produces English. Unresolved, and it affects voice selection and topic choice.

**Whether stills alone hold attention.** The honest risk of this format is that it reads as
a slideshow. Resolved by measuring retention at 5, 15 and 30 seconds on real published
episodes — and if it fails there, by adding generated motion for a small number of hero
beats rather than by rebuilding the format again.
