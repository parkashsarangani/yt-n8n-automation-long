/**
 * Blob store (RFC 0002 §Storage).
 *
 * Artifacts stay small and queryable; bytes live here, content-addressed by the
 * same sha256 scheme. Immutable and dedup-by-content, exactly like artifacts —
 * generating the same image twice costs one copy on disk.
 *
 * Retention (RFC 0002): blob CONTENT may be pruned while the artifact envelope
 * and lineage survive. A pruned blob must be marked, never silently missing, so
 * that replay fails loudly instead of producing a different video.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, stat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BlobRef } from "./artifact.ts";

export const BLOB_URI_PREFIX = "blob://sha256:";

export class BlobStoreError extends Error {
  override name = "BlobStoreError";
}

export function isBlobUri(uri: string): boolean {
  return /^blob:\/\/sha256:[0-9a-f]{64}$/.test(uri);
}

export interface PutBlobOptions {
  role: string;
  media_type?: string;
}

export interface BlobStore {
  put(bytes: Uint8Array, opts: PutBlobOptions): Promise<BlobRef>;
  get(uri: string): Promise<Uint8Array>;
  has(uri: string): Promise<boolean>;
}

export class FsBlobStore implements BlobStore {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<FsBlobStore> {
    await mkdir(path.join(root, "blobs"), { recursive: true });
    await mkdir(path.join(root, "tmp"), { recursive: true });
    return new FsBlobStore(root);
  }

  private pathFor(uri: string): string {
    if (!isBlobUri(uri)) throw new BlobStoreError(`malformed blob uri: ${uri}`);
    const hex = uri.slice(BLOB_URI_PREFIX.length);
    return path.join(this.root, "blobs", hex.slice(0, 2), hex);
  }

  async put(bytes: Uint8Array, opts: PutBlobOptions): Promise<BlobRef> {
    const hex = createHash("sha256").update(bytes).digest("hex");
    const uri = `${BLOB_URI_PREFIX}${hex}`;
    const dest = this.pathFor(uri);

    // Content-addressed, so an existing file is byte-identical by construction.
    if (!(await this.has(uri))) {
      await mkdir(path.dirname(dest), { recursive: true });
      const tmp = path.join(this.root, "tmp", randomUUID());
      await writeFile(tmp, bytes);
      await rename(tmp, dest);
    }

    return {
      role: opts.role,
      uri,
      bytes: bytes.byteLength,
      ...(opts.media_type ? { media_type: opts.media_type } : {}),
    };
  }

  async get(uri: string): Promise<Uint8Array> {
    try {
      const buf = await readFile(this.pathFor(uri));
      // Verify on read, as the artifact store does: a mismatch means the file
      // is not what it claims to be.
      const hex = createHash("sha256").update(buf).digest("hex");
      if (`${BLOB_URI_PREFIX}${hex}` !== uri) {
        throw new BlobStoreError(`content hash mismatch for ${uri}`);
      }
      // Return a plain Uint8Array, not a Buffer: the interface promises the
      // former, and callers should not depend on Node-specific methods. This is
      // a zero-copy view, so it stays cheap for large media.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BlobStoreError(`blob not found (pruned or never written): ${uri}`);
      }
      throw err;
    }
  }

  async has(uri: string): Promise<boolean> {
    try {
      await stat(this.pathFor(uri));
      return true;
    } catch {
      return false;
    }
  }

  /** Total bytes held, for the retention decisions RFC 0002 defers. */
  async size(): Promise<{ count: number; bytes: number }> {
    const base = path.join(this.root, "blobs");
    let count = 0;
    let bytes = 0;
    for (const shard of await readdir(base, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      for (const f of await readdir(path.join(base, shard.name))) {
        count += 1;
        bytes += (await stat(path.join(base, shard.name, f))).size;
      }
    }
    return { count, bytes };
  }
}

/** In-memory, for tests. */
export class MemoryBlobStore implements BlobStore {
  private readonly data = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array, opts: PutBlobOptions): Promise<BlobRef> {
    const hex = createHash("sha256").update(bytes).digest("hex");
    const uri = `${BLOB_URI_PREFIX}${hex}`;
    if (!this.data.has(uri)) this.data.set(uri, bytes);
    return {
      role: opts.role,
      uri,
      bytes: bytes.byteLength,
      ...(opts.media_type ? { media_type: opts.media_type } : {}),
    };
  }

  async get(uri: string): Promise<Uint8Array> {
    const b = this.data.get(uri);
    if (!b) throw new BlobStoreError(`blob not found: ${uri}`);
    return b;
  }

  async has(uri: string): Promise<boolean> {
    return this.data.has(uri);
  }

  get count(): number {
    return this.data.size;
  }
}
