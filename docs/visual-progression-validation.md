# Watchability release

This release uses scene-specific approved cards: exact narration excerpts, a comparison revealed as each response is spoken, and one exercise step at a time. It preserves the existing earned-progression prompts, early useful value, concise ending and one relevant discussion invitation. It retains one optional illustration; it does not claim to generate multiple coherent character scenes.

Every card item is mechanically grounded in narration, with word boundaries and order checked. Captions remain separate, while card lines and long tokens wrap. Character alignment times reveal items when available; legacy narration uses proportional timing.

OCR rejects text-bearing artwork before background and thumbnail composition. Missing or failed OCR is an explicit render error, not silent rejection of every image. English data is installed explicitly and checked during image build. OCR is a text screen, not a comprehensive factual or aesthetic image assessment.

The earlier failing thumbnail test reused a completed text-bearing thumbnail as its supposedly clean input. CI logs show English OCR data was installed. Tests now separately verify clean supplied artwork, rejection of lettering, and OCR service failure.

Validation includes the full engine suite and container compositor suite. Run `node scripts/visual-smoke.js /outputs` inside the compositor image for a reproducible spoken layout fixture and contact sheet. Its synthetic voice tests timing and layout, not production vocal persuasion. Autonomous publishing policy is unchanged.

After publishing real episodes, compare like-for-like impression CTR, first-30-second retention, average percentage viewed, transition dips, and relevant discussion responses. These changes support clearer viewing; tests cannot establish increased views or retention.
