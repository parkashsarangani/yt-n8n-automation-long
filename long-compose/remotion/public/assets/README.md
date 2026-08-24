# Local render assets

This directory is the render-time asset library for cartoon videos.

Rules:

- Rendering must not call Iconify, LottieFiles, GitHub, CDNs, or any external API.
- External libraries are acquisition sources only; approved assets are copied here as local files.
- Every local file must have an entry in `manifest.json` with source family and license metadata.
- Prefer complete `scenePlate` SVGs for backgrounds. Characters, captions, small props, and effects are layered on top.
- Use generated JSX fallbacks only when no approved local asset exists.

Source families currently supported by the registry:

- `scene-pack`: complete local background plates and set-piece SVGs.
- `iconify`: small prop/object SVGs vendored from permissive icon sets.
- `open-peeps`: character parts/expression SVGs; CC0/public-domain source family.
- `lottie`: local JSON motion clips.
- `remotion-bits`: internal Remotion component/motion primitives.

The first operational target is scene plates because they solve the largest observed quality issue: videos feeling like characters standing in a generic room rather than inhabiting a real setting.
