# Quiet Signal: competitiveness audit and correction pass

## Verdict
There is no evidence yet that this automated format will perform strongly. Technical correctness is necessary, not a prediction of audience satisfaction. The uploaded Interest Without Pressure file is 592.67 seconds at 910×512; this may be a shared/re-encoded copy, not the original production resolution. Sampled frames at 00:30 and 05:00 show permanent malformed image text colliding with changing subtitles. No full audio listening or live retention audit was completed in this environment.

## Verification of the proposed findings
0. Confirmed in code: separate thumbnail and episode prompts, independently generated. Replaced with exact episode-artwork reuse for the production thumbnail. This removes a visual disconnect; its retention impact is an unmeasured hypothesis.
1. Confirmed lack of shared art direction. Added a central charcoal/teal/ivory contemporary editorial style and deterministic subtitle area. Prompt consistency is not pixel-identical brand enforcement.
2. A visible host may help trust, but 'faceless cannot compete' is not established. Do not invent a host biography or impersonate an expert. This remains a faceless demonstration-led format; it needs audience testing against alternatives.
3. Honesty does not prohibit memorable names. New prompts allow one clearly labelled original memory aid and a concise quotable takeaway, without passing either off as validated science.
4. Add one relevant optional discussion invitation after value, not outrage or engagement demands. YouTube documents satisfaction, watch history, likes/dislikes and other signals; it does not establish comments as a strongest signal or guarantee reach from comment bait.
5. Confirmed no deterministic measured chapters in publishing. Added role-based chapters from voice clip durations, minimum three chapters, 00:00 start and ten-second spacing. Existing chapters are preserved. Very full descriptions omit chapters with a warning rather than truncating approved text.
6. Partially contradicted: prior writer prompt already says episodes stand alone. Reinforced cold-entry titles and narration in both packager and writer; curriculum numbering stays internal. A model audience_size score is not actual subscriber evidence.
7. The alleged 685 runs and outage start date are unverified without production logs. Confirmed and fixed two code defects: visibility errors silently swallowed, and blocked measurement graphs reported as measured zero views. This does not repair missing scopes, expired OAuth or undocumented API support. Missing CTR must remain unknown.

## Additional issues addressed
- Prompting 'no text' cannot ensure readable captions: an opaque lower subtitle band now hides conflicting artwork there, tested on a bright image.
- Explicit caption line breaks reduce overflow; the lesson heading only appears for the first eight seconds.
- Restore natural-speed default 1.0 after the selected voice sounded too slow at 0.9. Existing runtime overrides must be checked. No voice replacement or persuasiveness improvement has been auditioned.
- New scripts demand early usable dialogue, progressive applications, meaningful exceptions and a final takeaway rather than repeated advice padded to duration. These are editorial instructions, not a guarantee that every generation meets them.

## Release acceptance still required
Deploy, regenerate a private episode, and inspect the actual output with sound. Check active voice/speed, caption sync on mobile, artwork, chapters and thumbnail. Inspect measurement run failures and credential scopes before declaring analytics recovered. Never merge based on this document alone.

Run a small sequence of independently accessible episodes, changing one major packaging/format variable at a time. Compare like-for-like traffic sources and exposure windows, first-30-second retention, average percentage viewed, returning viewers and qualitative comments. Treat small samples and unavailable impressions/CTR as uncertainty. Do not promise a universal CTR floor or virality score.

Sources: https://support.google.com/youtube/answer/16089387 ; https://support.google.com/youtube/answer/9884579 ; https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/

## Audio follow-up
The current voice inherited stability 0.45 and style 0.35; neither was auditioned for this voice. Stability and style are now configurable through deployment and the engine config API. Baseline: speed 1.0, stability 0.45, style 0. Lower stability 0.35 is a comparison candidate, not an asserted improvement. Higher style is not a universal persuasion setting; ElevenLabs notes speed inconsistency and extra sounds with exaggeration (https://elevenlabs.io/docs/resources).

Voice progress records report measured per-scene WPM. QA warns outside a provisional 130–185 programme WPM range, and for substantial individual scenes below 110 or above 210. These warnings use the existing private-publish path; they do not automatically rewrite or re-synthesise narration. Aim around 145–170 WPM, but listen for natural pauses, credible emphasis and clear contrasts; numbers alone cannot prove persuasive delivery. Existing slow voice artifacts require explicit regeneration. No paid audition was possible in this workspace.
