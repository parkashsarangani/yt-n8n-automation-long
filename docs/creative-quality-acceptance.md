# Creative quality acceptance contract

> **Superseded by [RFC 0008](0008-illustrated-story-format.md).** This was the review
> contract for the two-host character/cartoon render pipeline, which RFC 0008 retired
> entirely — there is no camera/shot plan, no characters, no captions-vs-dialogue
> concern left to judge. Kept for historical context only; do not review new work
> against it.

This project should not accept a cartoon render merely because it is technically valid. The target is a custom-made, directed episode that does not look like a beginner Remotion scene assembled from generic rooms, floating icons, and repeated captions.

This document is the review contract for large quality PRs such as PR96. Claude Code should review the implementation against this contract before merge, and every fresh render should be judged against the same criteria.

## Target bar

A 9.5-style cartoon output must satisfy all of the following:

1. The viewer can understand the physical situation with captions muted.
2. The episode has a visible opening problem, middle escalation, practical action, and payoff.
3. The camera/shot plan changes intentionally: establishing shot, two-shot, reaction close-up, prop insert, transition, and payoff hold are used where appropriate.
4. Characters are grounded inside the scene and do not float over background plates.
5. Props look like physical objects in the world unless the scene explicitly asks for a UI badge or abstract overlay.
6. Spatial stories show actual spatial continuity. Doorway/walking topics require room A, crossing, room B, and payoff/return logic.
7. Dialogue has no exact repeated caption lines, no near-duplicate coaching lines, and no object chants such as `Charger. Charger.` unless the line is a single intentional gag and not repeated elsewhere.
8. Set pieces such as doors, windows, beds, lockers, and vehicles do not become giant foreground stickers covering the characters.
9. The render has visual rhythm: shot recipes, prop motion, reaction beats, and transitions vary across the episode.
10. The final payoff shows changed behavior instead of restating the lesson.

## Automatic creative failures

Reject or force retry if any of these appear in a generated episode:

- same room for nearly every content scene in a long episode;
- door or other set piece visible in almost every shot;
- charger/phone/keys/document appears as a generic square icon card when it is meant to be held or placed on a table/counter/floor;
- exact repeated caption line anywhere in the episode;
- near-duplicate caption lines within five scenes;
- repeated first three words across three or more spoken lines;
- more than two consecutive scenes with the same shot recipe;
- no `establishing`, no `prop-insert`, or no `payoff-hold` in a long cartoon episode;
- long episode has fewer than two background-location/variant pairs;
- doorway topic has no `crossing-transition` recipe;
- compiler emits a set-piece prop as `visualEvent.foregroundProp` instead of `background.setPiece`;
- renderer uses `ui-badge` mode for a physical prop placement such as `hand-held`, `on-table`, `on-counter`, or `floor`.

## Enforcement map

The quality bar is implemented across several layers:

- `engine/prompts/dialogue_script_writer/9.md`: prevents repeated, robotic, explainer-style dialogue and forces action-first metadata.
- `engine/prompts/cartoon_creative_director/4.md`: forces callback architecture, blocking, metaphor specificity, and performance direction.
- `engine/prompts/cartoon_visual_planner/11.md`: forces scene continuity, shot recipes, prop placement, and camera intent.
- `engine/src/agent-validators.ts`: rejects duplicate dialogue and static visual plans before render.
- `engine/src/workers/cartoon-scenes-v14.ts`: injects cinematic metadata and keeps set pieces in the background layer.
- `long-compose/remotion/src/lib/cinematicDirection.ts`: defines the renderer contract for shot recipes, prop placement, transitions, camera intent, and physical-vs-badge mode.
- `long-compose/remotion/src/compositions/CartoonScene.tsx`: consumes the cinematic contract in the visual renderer.
- `long-compose/remotion/src/components/PropAsset.tsx`: renders physical props by default and only uses badge mode explicitly.

## Review method

Claude Code should review PR96 using three passes:

1. Code pass: confirm the contracts above are wired, not just declared.
2. Test pass: run engine and long-compose tests; inspect stale source-scanning tests and update only if behavior is still covered.
3. Output pass: after merge/deploy, generate the same doorway-effect episode and compare against the previous 7.9/10 MP4.

A PR can be architecturally correct and still fail the output pass. The score is earned by the rendered MP4, not by the PR description.

## Expected next-render evidence

For the doorway-effect sample, the next MP4 should visibly show:

- a living-room or desk setup for the original intention;
- a hallway/doorway crossing shot;
- a different room after crossing;
- the remembered object placed physically, not as a badge;
- a reaction close-up or visual proof beat;
- a payoff that repeats the opening problem with changed behavior;
- no exact repeated captions.
