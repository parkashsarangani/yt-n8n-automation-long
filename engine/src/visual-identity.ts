/**
 * Shared Quiet Signal identity. Applied to the single episode artwork, which
 * publish.ts also reuses verbatim as the production thumbnail (see render.ts /
 * thumbnail.ts's shared-artwork path).
 *
 * Because the same image now serves double duty, its composition follows
 * vidIQ's 2026 breakout-thumbnail study (500 videos, 30 niches -- 69% of
 * breakouts featured a human face, rising to 80% among the biggest
 * overperformers; 89% used a face or high-contrast color; only 1 in 20 used
 * an exaggerated expression, so a genuine one reads better than manufactured
 * shock): one person, not two, front or three-quarter facing so the
 * expression actually reads, filling roughly a third of the frame -- a
 * two-person profile-view conversation has no single focal point and reads as
 * "restrained painterly realism," not the high-contrast single-subject shot
 * that the data says wins the thumbnail click. It still works as a calm
 * 10-minute audio-first backdrop; nothing here asks for the video's action to
 * be showy, only for a clear subject who is visibly present.
 * https://vidiq.com/blog/post/youtube-thumbnail-design-tips/
 */
export const CHANNEL_ART_DIRECTION = "Quiet Signal editorial illustration: one contemporary adult in a believable social situation, restrained painterly realism, charcoal and deep teal shadows, warm ivory light, subtle amber focal accent. Front or three-quarter facing (never profile or turned away), a genuine, clearly readable expression suited to the scene -- curiosity, warmth or focus, never manufactured shock or exaggerated surprise. The subject's face fills roughly a third of the frame. Consistent natural proportions, believable expression, eye-level framing. No vintage costume, no stock-photo studio posing. Absolutely no letters, writing, subtitles, typography, signs, logos, posters or watermarks. Keep the subject's face in the upper-right half, readable when the left half is covered by a thumbnail title panel. Reserve the top 14 percent and bottom 25 percent as dark empty space for deterministic overlays.";

export function episodeArtPrompt(context: string): string {
  return `${CHANNEL_ART_DIRECTION} Match the emotional stakes of the actual context: interruption or disagreement calls for composed attention or restrained concern, never an unrelated beaming smile. Show the protagonist making a choice, not a collage of cheerful bystanders. Depict the interaction, not the written words. Scene context (do not render as text): ${context.slice(0, 800)}`;
}
