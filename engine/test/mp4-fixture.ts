/**
 * Minimal ISO-BMFF builders, shared by the tests that need real MP4 bytes
 * rather than a mock — anything exercising readMp4Geometry or
 * assertYouTubeProductionGeometry has to hand those functions actual boxes.
 *
 * Deliberately not a `.test.ts` file: the runner globs those, and importing
 * one from another would run its tests twice.
 */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** Track header carrying only the display size the geometry reader looks at. */
export function tkhd(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(84);
  const view = new DataView(payload.buffer);
  view.setUint32(76, Math.round(width * 65536), false);
  view.setUint32(80, Math.round(height * 65536), false);
  return box("tkhd", payload);
}

/** A zero-sized audio track plus a video track, which is what the reader expects. */
export function mp4(width: number, height: number): Uint8Array {
  return box("moov", concat(box("trak", tkhd(0, 0)), box("trak", tkhd(width, height))));
}

/** The production geometry every returned cut has to satisfy. */
export function mp4_1080p(): Uint8Array {
  return mp4(1920, 1080);
}
