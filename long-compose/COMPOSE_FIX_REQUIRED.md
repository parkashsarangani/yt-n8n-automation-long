# Required permanent compose.js fix

This marker exists so PR review does not miss the remaining blocker.

PR #71 is not merge-ready until `long-compose/compose.js` itself, not a runtime wrapper, permanently implements:

1. Cartoon `buildProps` forwards `visualEvent` and `speakerEmphasis` into `CartoonScene`.
2. Cartoon template renders preserve the concatenated scene audio as the final voice source so Rhubarb mouth cues and audible speech share the same scene boundaries.
3. Non-cartoon renders may continue using `buildGaplessVoice()`.
4. Tests in `long-compose/tests/compose-audio-routing.test.js` pass against the real `compose.js` source.

Delete this file in the same commit that edits `compose.js` directly.
