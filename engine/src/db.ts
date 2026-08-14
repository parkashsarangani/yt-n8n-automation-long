/**
 * Postgres connection pool.
 *
 * Shared across all Pg-backed stores. Connects only when DATABASE_URL is set;
 * otherwise the system uses the filesystem implementations as before.
 */

import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
    if (!pool) {
        const url = process.env["DATABASE_URL"];
        if (!url) throw new Error("DATABASE_URL is not set");
        pool = new pg.Pool({ connectionString: url, max: 10 });
    }
    return pool;
}

export function hasDatabase(): boolean {
    return Boolean(process.env["DATABASE_URL"]?.trim());
}

export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

/** Run the migration SQL against the database. Idempotent (IF NOT EXISTS). */
export async function migrate(): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(resolve(__dirname, "..", "migrations", "001_initial.sql"), "utf8");
    const p = getPool();
    await p.query(sql);
    console.log("[db] migration applied");
}
