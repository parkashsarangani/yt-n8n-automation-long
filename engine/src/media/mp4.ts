export interface Mp4Geometry {
  width: number;
  height: number;
}

interface BoxHeader {
  type: string;
  start: number;
  payloadStart: number;
  end: number;
}

const CONTAINERS = new Set(["moov", "trak"]);

function readU32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readU64(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 8 > bytes.length) return null;
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function readType(bytes: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function boxAt(bytes: Uint8Array, offset: number, limit: number): BoxHeader | null {
  const shortSize = readU32(bytes, offset);
  const type = readType(bytes, offset + 4);
  if (shortSize === null || type === null) return null;

  let headerSize = 8;
  let size = shortSize;
  if (shortSize === 1) {
    const extended = readU64(bytes, offset + 8);
    if (extended === null) return null;
    headerSize = 16;
    size = extended;
  } else if (shortSize === 0) {
    size = limit - offset;
  }

  if (size < headerSize || offset + size > limit || offset + size > bytes.length) return null;
  return { type, start: offset, payloadStart: offset + headerSize, end: offset + size };
}

function tkhdGeometry(bytes: Uint8Array, box: BoxHeader): Mp4Geometry | null {
  if (box.payloadStart >= box.end) return null;
  const version = bytes[box.payloadStart];
  // Width/height are 16.16 fixed-point values after the track matrix.
  const dimensionOffset = version === 1 ? 88 : version === 0 ? 76 : null;
  if (dimensionOffset === null) return null;
  const widthFixed = readU32(bytes, box.payloadStart + dimensionOffset);
  const heightFixed = readU32(bytes, box.payloadStart + dimensionOffset + 4);
  if (widthFixed === null || heightFixed === null) return null;
  const width = widthFixed / 65536;
  const height = heightFixed / 65536;
  if (!(width > 0 && height > 0)) return null; // audio tracks normally report 0x0
  return { width: Math.round(width), height: Math.round(height) };
}

function collectGeometry(bytes: Uint8Array, start: number, end: number, out: Mp4Geometry[]): void {
  let offset = start;
  while (offset + 8 <= end) {
    const box = boxAt(bytes, offset, end);
    if (!box) return;
    if (box.type === "tkhd") {
      const geometry = tkhdGeometry(bytes, box);
      if (geometry) out.push(geometry);
    } else if (CONTAINERS.has(box.type)) {
      collectGeometry(bytes, box.payloadStart, box.end, out);
    }
    if (box.end <= offset) return;
    offset = box.end;
  }
}

/**
 * Read display dimensions from MP4 track headers. Audio tracks are ignored
 * because their tkhd width/height are zero; for files with multiple visual
 * tracks, select the largest display area as the primary programme video.
 */
export function readMp4Geometry(bytes: Uint8Array): Mp4Geometry | null {
  const candidates: Mp4Geometry[] = [];
  collectGeometry(bytes, 0, bytes.length, candidates);
  if (!candidates.length) return null;
  return candidates.reduce((best, item) =>
    item.width * item.height > best.width * best.height ? item : best,
  );
}

/** Long-form production invariant for this repository's YouTube target. */
export function assertYouTubeProductionGeometry(bytes: Uint8Array): Mp4Geometry {
  const geometry = readMp4Geometry(bytes);
  if (!geometry) {
    throw new Error("publish to youtube rejected before upload: could not read MP4 display geometry");
  }
  if (geometry.width !== 1920 || geometry.height !== 1080) {
    throw new Error(
      `publish to youtube rejected before upload: video is ${geometry.width}x${geometry.height}; production requires 1920x1080`,
    );
  }
  return geometry;
}
