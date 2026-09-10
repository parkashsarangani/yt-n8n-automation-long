# VidGen engine

The engine executes typed artifact graphs. The production graph is `graphs/illustrated_story.json`, version 10, despite its historical identifier.

Its production path is:

`intent → package → story → narration → moderation → voice → render → QA → publish`

Thumbnail design/rendering and SEO run beside the narration path and join before publishing. Visual scene generation is not part of this graph.

Key directories:

- `agents/` and `prompts/`: data-defined editorial transformations
- `schemas/`: active artifact contracts and compatible historical versions
- `src/workers/`: deterministic effects
- `src/providers/`: text, speech, thumbnail-artwork, compositor, YouTube, and analytics adapters
- `test/`: unit and graph-contract suites

Run:

```bash
npm ci
npm run typecheck
npm test
```
