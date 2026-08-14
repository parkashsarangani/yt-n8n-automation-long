/**
 * Blob cleanup.
 *
 * After a run completes and publishes successfully, intermediate blobs
 * (images, audio clips, alignment JSON) are no longer needed — the final
 * video is on YouTube. Mark them for cleanup and periodically sweep the disk.
 *
 * The final video blob is NOT cleaned (it stays in long-compose outputs).
 * Only brain-side blobs (per-scene images, per-scene audio) are removed.
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import type { PgRunLog } from "./pg-runlog.ts";
import { BLOB_URI_PREFIX } from "./blobs.ts";

export interface CleanupResult {
    marked: number;
    deleted: number;
    errors: number;
}

/**
 * Mark all blobs created by a run as eligible for cleanup.
 * Call this after publish completes successfully.
 */
export async function markRunForCleanup(pgLog: PgRunLog, runId: string): Promise<number> {
    return pgLog.markBlobsForCleanup(runId);
}

/**
 * Delete unreferenced blobs from disk and remove their registry entries.
 * Call periodically (e.g. after each successful publish) or on a schedule.
 */
export async function sweepBlobs(pgLog: PgRunLog, blobsDir: string): Promise<CleanupResult> {
    const uris = await pgLog.getUnretainedBlobs();
    let deleted = 0;
    let errors = 0;

    for (const uri of uris) {
        const hex = uri.slice(BLOB_URI_PREFIX.length);
        const filePath = path.join(blobsDir, hex.slice(0, 2), hex);
        try {
            await unlink(filePath);
            await pgLog.deleteBlobRef(uri);
            deleted++;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                // Already gone — just remove the registry entry
                await pgLog.deleteBlobRef(uri);
                deleted++;
            } else {
                errors++;
            }
        }
    }

    if (deleted > 0 || errors > 0) {
        console.log(`[cleanup] swept ${deleted} blobs, ${errors} errors`);
    }
    return { marked: uris.length, deleted, errors };
}
