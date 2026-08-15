/**
 * Integration test: PgRunLog + executor against a real Postgres via testcontainers.
 *
 * Validates the exact bug: graph_id must be stored and retrieved correctly,
 * or deriveCompleted returns 0 nodes and the executor blocks immediately.
 *
 * Run: node --import tsx --test test/pg-integration.test.ts
 * Requires: Docker running on the host.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PgRunLog } from "../src/pg-runlog.ts";
import type { RunRecord } from "../src/runlog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(resolve(__dirname, "..", "migrations", "001_initial.sql"), "utf8");

describe("PgRunLog integration", () => {
    let container: StartedPostgreSqlContainer;
    let pool: pg.Pool;
    let runLog: PgRunLog;

    before(async () => {
        container = await new PostgreSqlContainer("postgres:16-alpine").start();
        pool = new pg.Pool({ connectionString: container.getConnectionUri() });
        await pool.query(MIGRATION_SQL);
        // Also add graph_id column if not in migration (matches deployed state fix)
        await pool.query("ALTER TABLE run_records ADD COLUMN IF NOT EXISTS graph_id TEXT");
        runLog = new PgRunLog(pool);
    }, { timeout: 60_000 });

    test("a run record cannot be written before its run row exists", async () => {
        // The constraint that broke the first real measurement on the server:
        // run_records.run_id has a foreign key onto runs(run_id). measureAll
        // went straight to the executor without calling createRun, which the
        // filesystem run log tolerates and Postgres does not — so the bug was
        // invisible until it met production.
        const orphan: RunRecord = {
            run_id: "run_orphan_never_created",
            graph_id: "measure@1",
            node_id: "performance",
            transformation: "measure",
            transformation_version: "1",
            inputs: [],
            output: null,
            status: "ok",
            attempt: 1,
            max_attempts: 1,
            started_at: new Date().toISOString(),
            duration_ms: 0,
            error: null,
        };

        await assert.rejects(
            () => runLog.record(orphan),
            /foreign key|run_records_run_id_fkey/i,
            "an orphan run record must be refused, not silently accepted",
        );

        // With the run row created first, the same record is accepted.
        await runLog.createRun("run_orphan_never_created", "measure test", "measure@1");
        await assert.doesNotReject(() => runLog.record(orphan));
    });

    test("a run left at 'running' is a lie the runs table tells", async () => {
        // Found on the server: measurement created run rows and never closed
        // them, so measure@1 rows sat at "running" indefinitely. Nothing broke,
        // but the table misreports what is in flight — which is precisely what
        // an operator looks at when something seems stuck.
        await runLog.createRun("run_closeout", "measure vid", "measure@1");

        const before = (await runLog.listRuns()).find(r => r.run_id === "run_closeout");
        assert.equal(before?.status, "running", "a fresh run starts as running");

        await runLog.updateRunStatus("run_closeout", "completed", null);

        const after = (await runLog.listRuns()).find(r => r.run_id === "run_closeout");
        assert.equal(after?.status, "completed");
    });

    after(async () => {
        await pool.end();
        await container.stop();
    });

    test("record() stores graph_id and all() retrieves it", async () => {
        await runLog.createRun("run_test-001", "Test topic", "skeleton@5");

        const record: RunRecord = {
            run_id: "run_test-001",
            graph_id: "skeleton@5",
            node_id: "intent",
            transformation: "input",
            transformation_version: "1",
            inputs: [],
            output: "sha256:abc123",
            status: "ok",
            attempt: 1,
            max_attempts: 1,
            started_at: new Date().toISOString(),
            duration_ms: 0,
            error: null,
        };

        await runLog.record(record);
        const all = await runLog.all();

        assert.ok(all.length >= 1, "should have at least 1 record");
        const found = all.find(r => r.run_id === "run_test-001" && r.node_id === "intent");
        assert.ok(found, "should find the record we just inserted");
        assert.equal(found!.graph_id, "skeleton@5", "graph_id must be stored and retrieved");
        assert.equal(found!.output, "sha256:abc123");
        assert.equal(found!.status, "ok");
    });

    test("forRun() returns only records for that run", async () => {
        await runLog.createRun("run_test-002", "Test 2", "skeleton@5");

        await runLog.record({
            run_id: "run_test-002",
            graph_id: "skeleton@5",
            node_id: "story",
            transformation: "story_architect",
            transformation_version: "1",
            inputs: ["sha256:abc123"],
            output: "sha256:def456",
            status: "ok",
            attempt: 1,
            max_attempts: 1,
            started_at: new Date().toISOString(),
            duration_ms: 1500,
            error: null,
        });

        const records = await runLog.forRun("run_test-002");
        assert.equal(records.length, 1);
        assert.equal(records[0]!.node_id, "story");
        assert.equal(records[0]!.graph_id, "skeleton@5");
    });

    test("deriveCompleted logic: intent record is found by run_id + graph_id", async () => {
        const runId = "run_test-derive";
        const graphId = "skeleton@5";

        await runLog.createRun(runId, "Derive test", graphId);

        // Simulate what executor.start() does
        await runLog.record({
            run_id: runId,
            graph_id: graphId,
            node_id: "intent",
            transformation: "input",
            transformation_version: "1",
            inputs: [],
            output: "sha256:intent-artifact",
            status: "ok",
            attempt: 1,
            max_attempts: 1,
            started_at: new Date().toISOString(),
            duration_ms: 0,
            error: null,
        });

        // Simulate deriveCompleted filtering
        const allRecords = await runLog.all();
        const completed = new Map<string, string>();
        for (const r of allRecords) {
            if (r.run_id !== runId || r.graph_id !== graphId || !r.node_id) continue;
            if (!r.output) continue;
            if (r.status !== "ok" && r.status !== "cache_hit") continue;
            completed.set(r.node_id, r.output);
        }

        assert.equal(completed.size, 1, "should find exactly 1 completed node");
        assert.equal(completed.get("intent"), "sha256:intent-artifact");
    });

    test("createRun and listRuns work correctly", async () => {
        await runLog.createRun("run_test-list", "Test topic", "skeleton@5");
        const runs = await runLog.listRuns();
        const found = runs.find(r => r.run_id === "run_test-list");
        assert.ok(found, "run should appear in list");
        assert.equal(found!.brief, "Test topic");
        assert.equal(found!.status, "running");
    });

    test("updateRunStatus transitions correctly", async () => {
        await runLog.createRun("run_test-status", "Status test", "skeleton@5");
        await runLog.updateRunStatus("run_test-status", "completed");
        const run = await runLog.getRun("run_test-status");
        assert.ok(run);
        assert.equal(run!.status, "completed");
        assert.ok(run!.finished_at, "finished_at should be set");
    });

    test("INSERT column count matches parameter count", async () => {
        await runLog.createRun("run_test-columns", "Column test", "skeleton@5");

        // This test validates that the INSERT statement has the right number
        // of columns and parameters — the exact class of bug we hit.
        const record: RunRecord = {
            run_id: "run_test-columns",
            graph_id: "skeleton@5",
            node_id: "test_node",
            transformation: "test_transform",
            transformation_version: "1",
            inputs: ["a", "b"],
            output: "sha256:output",
            status: "ok",
            attempt: 2,
            max_attempts: 3,
            provider: "anthropic",
            model: "claude-sonnet-5",
            prompt_ref: "story_architect@1",
            usage: { input_tokens: 100, output_tokens: 200, cost_usd: 0.01, provider: "anthropic", model: "claude-sonnet-5" },
            confidence: { overall: 0.85 },
            started_at: new Date().toISOString(),
            duration_ms: 5000,
            error: null,
            external_job_id: "job-123",
            detail: "some detail",
        };

        // Should not throw — if column count mismatches, this fails
        await runLog.record(record);

        const retrieved = (await runLog.forRun("run_test-columns"))[0]!;
        assert.equal(retrieved.graph_id, "skeleton@5");
        assert.equal(retrieved.node_id, "test_node");
        assert.equal(retrieved.transformation, "test_transform");
        assert.deepEqual(retrieved.inputs, ["a", "b"]);
        assert.equal(retrieved.output, "sha256:output");
        assert.equal(retrieved.attempt, 2);
        assert.equal(retrieved.provider, "anthropic");
        assert.equal(retrieved.model, "claude-sonnet-5");
        assert.equal(retrieved.external_job_id, "job-123");
        assert.equal(retrieved.detail, "some detail");
        assert.equal(retrieved.usage?.cost_usd, 0.01);
    });
});
