/**
 * Persistent content-addressed image bank.
 *
 * Wraps any ImageProvider. Every generated image is written as two files under
 * `IMAGE_BANK_DIR`:
 *   <key>.bin   - the raw image bytes
 *   <key>.json  - metadata: the full prompt and every other input that
 *                 determined this image, plus provenance
 *
 * A later request whose inputs hash to the same <key> returns the stored bytes
 * for free instead of paying the provider again. The metadata sidecar makes a
 * cache hit auditable: you can see exactly which prompt / aspect / seed /
 * reference / model produced each cached image, and safely prune the bank.
 *
 * The key covers EVERY input that changes fal's output — provider id + model,
 * operation (generate vs reference pack), full prompt text, aspect, tier,
 * seed, and the SHA-256 of any reference image. Change any of those and you
 * get a fresh generation, not a stale hit.
 *
 * Point `IMAGE_BANK_DIR` at a path on a Docker volume that survives
 * `compose down` and the bank persists across CI runs.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import type { Aspect, ImageBankContext, ImageProvider, Usage } from "../provider.ts";

interface GenImage {
  bytes: Uint8Array;
  media_type: string;
}

interface PackReq {
  prompts: string[];
  aspect: Aspect;
  seed: number;
  reference?: GenImage;
  tier?: "hero" | "standard";
  context?: ImageBankContext;
}

interface PackCapable {
  generatePack(req: PackReq): Promise<{ images: GenImage[]; usage: Usage }>;
}

/** Everything persisted alongside the bytes so a cached image is reusable
 * with full context, not just a hash. */
export interface ImageBankEntry {
  key: string;
  /** "generate" (plain text-to-image) or "pack" (fal reference-conditioned shot pack). */
  op: "generate" | "pack";
  /** The exact, full prompt string sent to the provider. Never truncated. */
  prompt: string;
  aspect: Aspect;
  tier: "hero" | "standard" | null;
  /** Present for pack ops (fal seeds each pack image seed+i). */
  seed: number | null;
  /** SHA-256 of the reference image bytes, for reference-conditioned packs. */
  reference_sha256: string | null;
  provider: string;
  media_type: string;
  bytes: number;
  /** Pixel dimensions when parseable (PNG/JPEG), else null. */
  width: number | null;
  height: number | null;
  content_sha256: string;
  created_at: string;
  /**
   * The narration beat / visual requirement this image was produced for.
   * The exact-key hash above is how a hit is found today; this is what a
   * future semantic-reuse layer (or a human pruning the bank) matches on.
   */
  context: ImageBankContext | null;
}

function sha(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function zeroUsage(provider: string): Usage {
  return { input_tokens: 0, output_tokens: 0, units: 0, cost_usd: 0, provider, model: provider };
}

/** Best-effort pixel dimensions from a PNG IHDR or JPEG SOF marker. */
function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR (length+type at 8..16), width/height big-endian at 16..24
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // JPEG: scan for a Start-Of-Frame marker (0xFFC0..0xFFCF except C4/C8/CC)
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
        const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
        return { width, height };
      }
      const segLen = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (segLen < 2) break;
      i += 2 + segLen;
    }
  }
  return null;
}

export class CachedImageProvider implements ImageProvider {
  readonly id: string;
  private readonly dir: string;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: ImageProvider,
    dir: string | undefined,
    private readonly logger: Pick<Console, "log" | "warn"> = console,
  ) {
    this.id = inner.id;
    this.dir = dir?.trim() || path.join(process.env["AMOS_DATA"] ?? ".vidgen-data", "image-bank");
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.logger.warn(`[image-bank] cannot create ${this.dir} (${String(err)}); cache disabled`);
      this.dir = "";
    }
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  private key(parts: Record<string, unknown>): string {
    return sha(JSON.stringify({ provider: this.inner.id, ...parts }));
  }

  private read(key: string): GenImage | null {
    if (!this.dir) return null;
    const bin = path.join(this.dir, `${key}.bin`);
    const meta = path.join(this.dir, `${key}.json`);
    if (!existsSync(bin) || !existsSync(meta)) return null;
    try {
      const entry = JSON.parse(readFileSync(meta, "utf8")) as ImageBankEntry;
      return { bytes: new Uint8Array(readFileSync(bin)), media_type: entry.media_type || "image/png" };
    } catch {
      return null;
    }
  }

  private write(
    key: string,
    image: GenImage,
    fields: Pick<ImageBankEntry, "op" | "prompt" | "aspect" | "tier" | "seed" | "reference_sha256">,
    context: ImageBankContext | undefined,
  ): void {
    if (!this.dir) return;
    try {
      const dims = imageDimensions(image.bytes);
      const entry: ImageBankEntry = {
        key,
        ...fields,
        provider: this.inner.id,
        media_type: image.media_type,
        bytes: image.bytes.byteLength,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        content_sha256: sha(image.bytes),
        created_at: new Date().toISOString(),
        context: context ?? null,
      };
      writeFileSync(path.join(this.dir, `${key}.bin`), image.bytes);
      writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(entry, null, 2));
    } catch (err) {
      this.logger.warn(`[image-bank] write failed for ${key} (${String(err)})`);
    }
  }

  async generate(req: { prompt: string; aspect: Aspect; count?: number; tier?: "hero" | "standard"; context?: ImageBankContext }): Promise<{ images: GenImage[]; usage: Usage }> {
    const count = Math.max(1, Math.min(5, req.count ?? 1));
    const tier = req.tier ?? null;
    const slotKey = (i: number) => this.key({ op: "generate", prompt: req.prompt, aspect: req.aspect, tier, i });
    const images: (GenImage | null)[] = Array.from({ length: count }, (_, i) => this.read(slotKey(i)));

    const missingIdx = images.map((img, i) => (img ? -1 : i)).filter((i) => i >= 0);
    this.hits += count - missingIdx.length;
    if (missingIdx.length === 0) {
      return { images: images as GenImage[], usage: zeroUsage(this.inner.id) };
    }

    this.misses += missingIdx.length;
    const fresh = await this.inner.generate({ prompt: req.prompt, aspect: req.aspect, count: missingIdx.length, ...(req.tier ? { tier: req.tier } : {}) });
    fresh.images.forEach((image, n) => {
      const slot = missingIdx[n]!;
      images[slot] = image;
      this.write(slotKey(slot), image, { op: "generate", prompt: req.prompt, aspect: req.aspect, tier, seed: null, reference_sha256: null }, req.context);
    });
    return { images: images.filter((x): x is GenImage => x !== null), usage: fresh.usage };
  }

  /** Video generation is passed straight through (rare, not cached here). */
  generateVideo(req: { prompt: string; aspect: Aspect }) {
    if (typeof this.inner.generateVideo !== "function") return Promise.resolve(null);
    return this.inner.generateVideo(req);
  }

  async generatePack(req: PackReq): Promise<{ images: GenImage[]; usage: Usage }> {
    const inner = this.inner as unknown as Partial<PackCapable>;
    if (typeof inner.generatePack !== "function") {
      throw new Error(`${this.id}: wrapped provider has no generatePack`);
    }
    const tier = req.tier ?? null;
    const refHash = req.reference ? sha(req.reference.bytes) : null;
    const keys = req.prompts.map((prompt, i) =>
      this.key({ op: "pack", prompt, aspect: req.aspect, seed: req.seed + i, tier, ref: refHash }),
    );
    const cached = keys.map((k) => this.read(k));
    if (cached.every((x) => x !== null)) {
      this.hits += cached.length;
      return { images: cached as GenImage[], usage: zeroUsage(this.inner.id) };
    }

    this.misses += req.prompts.length;
    const fresh = await inner.generatePack(req);
    fresh.images.forEach((image, i) => {
      if (keys[i]) {
        this.write(keys[i]!, image, {
          op: "pack",
          prompt: req.prompts[i] ?? "",
          aspect: req.aspect,
          tier,
          seed: req.seed + i,
          reference_sha256: refHash,
        }, req.context ? { ...req.context, concept_index: i } : undefined);
      }
    });
    return fresh;
  }
}
