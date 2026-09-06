/**
 * Deterministic text fitting for SVG captions and labels.
 *
 * SVG `<text>` does not wrap. The previous semantic scenes drew every caption
 * as one `<text x="550" textAnchor="middle">` node, so a rendered benchmark
 * put "Electronic delivery finishes before the sender's physical journey does"
 * on screen clipped off BOTH frame edges, and another caption ran straight
 * through the graphic it was captioning. Nothing detected it, because a
 * clipped `<text>` is not an error -- it just renders past the viewport.
 *
 * So: wrap explicitly, and shrink to fit rather than overflow. The engine
 * already caps caption/line length (`MAX_CAPTION_CHARS`), which keeps this
 * from ever having to shrink far; this is the renderer-side guarantee that
 * whatever arrives stays inside the safe area.
 */

/**
 * Mean advance width as a fraction of font size for the heavy sans face these
 * scenes use. Measured against Inter 800 over mixed-case English; digits and
 * caps run wider, which is why `wrapToWidth` uses a conservative 0.56 rather
 * than the ~0.50 a lowercase-only sample suggests. Over-estimating width only
 * costs a slightly smaller font; under-estimating clips the frame.
 */
export const AVG_GLYPH_RATIO = 0.56;

export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * AVG_GLYPH_RATIO;
}

export interface FittedText {
  lines: string[];
  fontSize: number;
}

/**
 * Break `text` into at most `maxLines` lines that each fit `maxWidth`, reducing
 * the font size (never below `minFontSize`) until they do.
 *
 * A word longer than the line budget is hard-broken rather than allowed to
 * overhang -- a single unbreakable token must not be the thing that pushes
 * pixels outside the safe area.
 */
export function fitText(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines = 2,
  minFontSize = 18,
): FittedText {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { lines: [], fontSize };

  for (let size = fontSize; size >= minFontSize; size -= 2) {
    const lines = wrapToWidth(clean, maxWidth, size);
    if (lines.length <= maxLines && lines.every((line) => textWidth(line, size) <= maxWidth)) {
      return { lines, fontSize: size };
    }
  }
  // Even at the minimum size it does not fit in `maxLines`: keep the leading
  // lines and mark the truncation rather than drawing off-frame.
  const lines = wrapToWidth(clean, maxWidth, minFontSize).slice(0, maxLines);
  const last = lines.length - 1;
  if (last >= 0 && wrapToWidth(clean, maxWidth, minFontSize).length > maxLines) {
    lines[last] = `${lines[last]!.replace(/[\s,.;:]+$/, "")}…`;
  }
  return { lines, fontSize: minFontSize };
}

export function wrapToWidth(text: string, maxWidth: number, fontSize: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, fontSize) <= maxWidth || !current) {
      // `!current` accepts an over-long first word here so the hard-break below
      // owns that case in one place instead of two.
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  const broken: string[] = [];
  const perLine = Math.max(1, Math.floor(maxWidth / (fontSize * AVG_GLYPH_RATIO)));
  for (const line of lines) {
    if (textWidth(line, fontSize) <= maxWidth) {
      broken.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += perLine) broken.push(line.slice(i, i + perLine));
  }
  return broken;
}
