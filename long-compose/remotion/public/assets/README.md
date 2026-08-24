# Local render assets

This directory is the render-time asset library for cartoon videos.

Rules:

- Rendering must not call Iconify, LottieFiles, GitHub, CDNs, or any external API.
- External libraries are acquisition/catalog sources only; approved assets must be copied here as local files.
- Every local file must have an entry in `manifest.json` with source family and license metadata.
- Prefer complete `scenePlate` SVGs for backgrounds. Characters, captions, small props, and effects are layered on top.
- Use generated JSX fallbacks only when no approved local asset exists.

Source families supported by the registry contract:

- `scene-pack`: complete local background plates and set-piece SVGs.
- `iconify`: small prop/object SVGs vendored from permissive icon sets.
- `open-peeps`: character parts/expression SVGs; CC0/public-domain source family.
- `lottie`: local JSON motion clips.
- `remotion-bits`: internal Remotion component/motion primitives.

Important status note: PR93 establishes the registry, manifest contract, local-only render path, and starter placeholder assets. The initial `iconify`, `open-peeps`, and `lottie` examples are locally authored placeholders that prove the pipeline shape; they are not yet real imported assets from those projects. Real third-party assets must be acquired offline, copied into this directory, and allowlisted in the manifest before use.

The first operational target is scene plates because they solve the largest observed quality issue: videos feeling like characters standing in a generic room rather than inhabiting a real setting.
