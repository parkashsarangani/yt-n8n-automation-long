# Stock suggestions for editor drafts

`FOOTAGE_MODE=stock` is the Docker/deploy default. Pexels provides photos and
videos; Unsplash provides photos only. Verified repository secrets
`PEXELS_API_KEY` and `UNSPLASH_ACCESS_KEY` are passed to long-compose.
Pixabay's optional adapter remains tested, but is not wired into deployment:
the repository has no `PIXABAY_API_KEY`. Enabling it requires adding a key
and explicitly wiring it into the compositor environment. Configured provider
names are logged without credential values. A repository variable FOOTAGE_MODE
can override the default; remove an old `graphics` override to enable stock.

The compositor derives short concrete search queries from common narrated
settings (office meetings, phone messages, cafes, restaurants, friends,
family, interviews, presentations). It ranks landscape results by overlap
between the search and source descriptions, preferring motion when suitable
and mixing in photos. These are metadata matches, not visual understanding or
verified depictions of the script. Abstract/unsupported situations, unrelated
results, failures, and scenes without a match keep the existing background.
No model is called and stock matching cannot block the script or draft render.

There are at most 24 searches, 12 unique download attempts of at most 25 MB,
and 120 seconds of network work per render. Sources returning errors are skipped
for the remainder of that render. Query responses are cached for 24 hours in
`/app/data/stock-cache`, including across restarts. Downloaded media stays in
the render's temporary directory and is removed with it. Existing matching
assets may be reused for later scenes, preferring a different previous asset.
Videos need at least min(scene duration, 8 seconds); a shorter clip's final frame
is held for the rest of the scene. Photos cover the scene. Equal relevance/kind
ties are seeded from the episode narration, stable on retry but varied across
episodes. Credit-budget-ineligible candidates consume no download slots;
already credited assets can be reused immediately when the credit budget fills.

Sources are fetched over HTTPS from allowed provider/CDN hosts, with bounded
redirects, response sizes and timeouts. API keys are not sent to media hosts
or included in diagnostics. Unsplash exports call `download_location` and use
the API-returned `urls.regular` URL, preserving its tracking parameters.

The renderer groups consecutive unmatched scenes into one background encode,
normalizes matched scenes one at a time and concatenates the results to
avoid opening every video decoder simultaneously. Each source is fitted above
the caption band; stock audio is discarded. The final encode uses the existing
measured narration, loudness normalization, burned captions and matching SRT.
Malformed media falls back per scene. If stock assembly fails, the whole draft
still renders over the original background.
Stock mode consistently hides navigation headings on matched and unmatched
scenes; legacy/manual cards still display. Motion tracks omit still-image tuning.

`package.md` labels stock as suggestions to keep or replace. `credits.json`
records source, creator, license, SHA-256 and scene index. Reused assets receive
only one publication credit. Original credits survive `final.mp4` import;
approved prose, chapters and attribution are never silently truncated. When
their combined length exceeds the destination limit, publication fails before
upload and requests a shorter approved SEO description.
The operator must reconcile credits for removed/replaced media and new editor
assets before publishing. The poller still imports only `final.mp4`, not an
edited thumbnail or a revised credits file. Narration and caption timing should
be preserved unless the editor also retimes the supplied SRT.

Thumbnail generation runs even when the draft has no background artwork.
Automatically suggested stock is not reused as thumbnail artwork. A gradient
thumbnail fallback is explicitly labelled as needing operator replacement in
the handoff. Existing Drive folders are not rewritten by this change.

Sources: [Pexels API](https://www.pexels.com/api/documentation/),
[Pixabay API](https://pixabay.com/api/docs/),
[Unsplash API](https://unsplash.com/documentation).

Verification: provider fixtures cover both media types, absent credentials,
rate limits, Unsplash download tracking, caching and download bounds. A real
FFmpeg integration test renders a video, photo and corrupt asset and samples
pixels, captions, timing and audio. Fixtures are synthetic test colors, not a
visual quality evaluation of real stock. A production render is still needed
to judge search relevance for an actual episode and confirm live credentials.
