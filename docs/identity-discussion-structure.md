# Follow-up to PR 279: points 1, 4 and 5

## Visual identity
Every video and thumbnail now receives the same deterministic charcoal/teal frame and two-bar ivory/amber motif. Thumbnails use an opaque left title panel with bounded ivory typography; episode navigation occupies an opaque top band, separate from captions. These elements survive image-provider failure. Generated artwork retains the existing shared art direction and exact episode-art reuse, with focal interaction requested on the right so the title panel does not cover it. Image composition still requires review; a prompt cannot guarantee placement.

## Discussion
Versioned packager and writer prompts require exactly one specific discussion invitation after useful value, before the replaceable outro. They require one recognisable awkward dialogue example and a plausible consequence, without manufactured outrage or humiliation. The critic explicitly checks these requirements and requests revisions through the existing report. This is an editorial generation/review requirement, not a deterministic guarantee of audience engagement. Previously generated scripts are unchanged.

## Navigation
On-screen role labels and scene progress advance at the compositor's measured audio boundaries. Chapter labels use the same wording. PR 279's publishing path still appends timestamps from measured voice durations, with its three-chapter and ten-second constraints. Incomplete or duplicate voice coverage now yields no fabricated chapters. Existing 0:00, 00:00 and hour-format chapter starts are recognized correctly, avoiding duplicate chapter lists. Existing description length protection remains in place.

## Verification
Engine typecheck and 323 tests passed before the final chapter-start regression was added; the final focused suite passed 29 tests. All 15 compositor tests passed, including actual FFmpeg video and thumbnail encoding. Generated fallback thumbnail/video frames were visually inspected locally. No paid generation, full spoken episode review, production publishing or deployment was performed. Merge/deploy and regenerate a private episode before assessing new generated examples, artwork placement and end-to-end timestamp alignment.
