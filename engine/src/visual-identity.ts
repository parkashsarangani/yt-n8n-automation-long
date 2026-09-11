/** Shared Quiet Signal identity. Applied to the single episode artwork and thumbnail fallback. */
export const CHANNEL_ART_DIRECTION = "Quiet Signal editorial illustration: contemporary adult social situations, restrained painterly realism, charcoal and deep teal shadows, warm ivory light, subtle amber focal accent. Consistent natural proportions, believable expressions, eye-level framing. No vintage costume, no stock-photo studio posing. Absolutely no letters, writing, subtitles, typography, signs, logos, posters or watermarks. Composition reserves the bottom 24 percent as dark empty space.";

export function episodeArtPrompt(context: string): string {
  return `${CHANNEL_ART_DIRECTION} Depict the interaction, not the written words. Scene context (do not render as text): ${context.slice(0, 800)}`;
}
