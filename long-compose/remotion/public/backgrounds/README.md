# Cartoon Background Library

Reusable environments for `CartoonScene`, matching the character pack's
visual language (thick outlines, flat saturated fills) so a puppet never
looks pasted onto a mismatched image. `manifest.json` in this directory is
the source pack's own documentation (locations/variants/style notes) —
kept for reference; `compose.js` doesn't read it, it just walks the
filesystem.

## Contract

```
backgrounds/
  <location>/
    <variant>/
      back.svg      (optional)
      middle.svg    (optional)
      front.svg     (optional)
```

- `location` — a place, e.g. `bedroom`, `classroom`, `kitchen`, `street`.
- `variant` — a state of that place, e.g. `day`, `night`, `messy-day`, `exam`.
- Each layer file is **optional** — a variant can ship just `back.svg`, or
  all three. `compose.js` checks the filesystem (`resolveBackgroundLayers`)
  before rendering, so a missing file never 404s inside the headless
  Chrome render — it's just skipped.
- A variant with no layer files at all is a valid "unbuilt" placeholder —
  the scene falls back to a plain mood-tinted gradient.

## Coordinate space

Every layer uses `viewBox="0 0 1920 1080"` — exactly the output frame, no
hand-authored margin required. Panning safety comes from `Background.tsx`
itself: each layer is scaled up ~1.15x internally before the parallax
offset is applied, giving ~144px of pan budget per side without the art
needing to draw anything outside the visible frame. Keep
`camera.panFrom`/`panTo` within roughly ±120px.

## Parallax

Back/middle/front move at 0.2x / 0.55x / 1.0x of the camera's horizontal
pan offset (`camera.panFrom` → `camera.panTo`, in px, over the scene's
duration) — the standard cheap-parallax trick: distant layers move less
than near ones. Characters render at the same 1.0x depth as the front
layer, so they move with the room during a pan instead of floating fixed
on screen.

## Tone

`background.tone` (`scary` | `happy` | `dramatic` | `cold` | `warm` |
`neutral`) applies a lighting preset on top of the layers — tint,
vignette, fog, subtle camera shake — defined in
`src/lib/environment.ts`. Separate from which SVGs you draw; the same
`bedroom/night` art can read as `scary` or `neutral` depending on the
scene.

## Flat mode

`background.flat` (a hex color, e.g. `"#C0392B"`) skips the location/
variant entirely and fills the frame with a solid color — reserved for
punchlines, extreme reactions, and transitions, not everyday scenes.

## Current library (20 locations, 23 variants)

bedroom (day, night, messy-day, messy-night) · cafe (day) · classroom
(empty, normal, exam) · generic-room (cool-day, warm-day, night) ·
hospital-room (day) · kitchen (day, night) · living-room (day, night) ·
office (day) · park (day, evening) · school-hallway (normal) · street
(day, night, rain-night)

## Adding a new location

Draw `back.svg` / `middle.svg` / `front.svg` at `viewBox="0 0 1920 1080"`
in the character pack's style (thick black strokes, flat saturated fills,
transparent background) and drop them in `<location>/<variant>/`. No code
changes needed — `compose.js` discovers layers by checking the filesystem.
