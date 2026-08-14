/**
 * Postgres-backed run log + runs table.
 *
 * Replaces JsonlRunLog when DATABASE_URL is set. Same RunLog interface,
 * plus methods for managing run state that the service needs.
 */

import type pg from "pg";
import type { RunLog, RunRecord, RunStatus } from "./runlog.ts";

export interface RunRow {
    run_id: string;
    brief: string;
    graph_id: string;
    status: string;
    cost_usd: number;
    error: string | null;
    created_at: string;
    finished_at: string | null;
}

export class PgRunLog implements RunLog {
    constructor(private readonly pool: pg.Pool) { }

    async record(r: RunRecord): Promise<void> {
        await this.pool.query(
            `INSERT INTO run_records (
        run_id, graph_id, node_id, transformation, transformation_version,
        inputs, output_artifact_id, status, attempt, max_attempts,
        provider, model, prompt_ref, usage_json, confidence_json,
        error, external_job_id, detail, started_at, duration_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [
                r.run_id,
                r.graph_id ?? null,
                r.node_id ?? null,
                r.transformation,
                r.transformation_version,
                JSON.stringify(r.inputs),
                r.output ?? null,
                r.status,
                r.attempt,
                r.max_attempts,
                r.provider ?? null,
                r.model ?? null,
                r.prompt_ref ?? null,
                r.usage ? JSON.stringify(r.usage) : null,
                r.confidence ? JSON.stringify(r.confidence) : null,
                r.error ?? null,
                r.external_job_id ?? null,
                r.detail ?? null,
                r.started_at,
                r.duration_ms,
            ],
        );
    }

    async all(): Promise<RunRecord[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM run_records ORDER BY id ASC`,
        );
        return rows.map(rowToRecord);
    }

    async forRun(runId: string): Promise<RunRecord[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM run_records WHERE run_id = $1 ORDER BY id ASC`,
            [runId],
        );
        return rows.map(rowToRecord);
    }

    // --- Run management ---

    async createRun(runId: string, brief: string, graphId: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO runs (run_id, brief, graph_id, status, created_at)
       VALUES ($1, $2, $3, 'running', NOW())
       ON CONFLICT (run_id) DO NOTHING`,
            [runId, brief, graphId],
        );
    }

    async updateRunStatus(runId: string, status: string, error?: string | null): Promise<void> {
        if (status === "completed" || status === "blocked" || status === "waiting") {
            await this.pool.query(
                `UPDATE runs SET status = $2, error = $3, finished_at = NOW() WHERE run_id = $1`,
                [runId, status, error ?? null],
            );
        } else {
            await this.pool.query(
                `UPDATE runs SET status = $2, error = $3 WHERE run_id = $1`,
                [runId, status, error ?? null],
            );
        }
    }

    async updateRunCost(runId: string, costUsd: number): Promise<void> {
        await this.pool.query(
            `UPDATE runs SET cost_usd = $2 WHERE run_id = $1`,
            [runId, costUsd],
        );
    }

    async listRuns(limit = 50): Promise<RunRow[]> {
        const { rows } = await this.pool.query(
            `SELECT run_id, brief, graph_id, status, cost_usd, error, created_at, finished_at
       FROM runs ORDER BY created_at DESC LIMIT $1`,
            [limit],
        );
        return rows;
    }

    async getRun(runId: string): Promise<RunRow | null> {
        const { rows } = await this.pool.query(
            `SELECT run_id, brief, graph_id, status, cost_usd, error, created_at, finished_at
       FROM runs WHERE run_id = $1`,
            [runId],
        );
        return rows[0] ?? null;
    }

    // --- Cleanup ---

    async markBlobsForCleanup(runId: string): Promise<number> {
        const { rowCount } = await this.pool.query(
            `UPDATE blob_refs SET retained = FALSE WHERE run_id = $1`,
            [runId],
        );
        return rowCount ?? 0;
    }

    async getUnretainedBlobs(): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT uri FROM blob_refs WHERE retained = FALSE`,
        );
        return rows.map((r: { uri: string }) => r.uri);
    }

    async deleteBlobRef(uri: string): Promise<void> {
        await this.pool.query(`DELETE FROM blob_refs WHERE uri = $1`, [uri]);
    }

    async registerBlob(uri: string, role: string, bytes: number, runId: string | null, mediaType?: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO blob_refs (uri, role, media_type, bytes, run_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (uri) DO NOTHING`,
            [uri, role, mediaType ?? null, bytes, runId ?? null],
        );
    }
}

function rowToRecord(row: any): RunRecord {
    return {
        run_id: row.run_id,
        graph_id: row.graph_id ?? null,
        node_id: row.node_id ?? null,
        transformation: row.transformation,
        transformation_version: row.transformation_version,
        inputs: typeof row.inputs === "string" ? JSON.parse(row.inputs) : (row.inputs ?? []),
        output: row.output_artifact_id ?? null,
        status: row.status as RunStatus,
        attempt: row.attempt,
        max_attempts: row.max_attempts,
        provider: row.provider ?? null,
        model: row.model ?? null,
        prompt_ref: row.prompt_ref ?? null,
        usage: row.usage_json ? (typeof row.usage_json === "string" ? JSON.parse(row.usage_json) : row.usage_json) : null,
        confidence: row.confidence_json ? (typeof row.confidence_json === "string" ? JSON.parse(row.confidence_json) : row.confidence_json) : null,
        started_at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
        duration_ms: row.duration_ms,
        error: row.error ?? null,
        external_job_id: row.external_job_id ?? null,
        detail: row.detail ?? null,
    };
}
