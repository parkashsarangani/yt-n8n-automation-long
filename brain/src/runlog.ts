/**
 * Run log (RFC 0006).
 *
 * One record per transformation execution — agent, worker, cache hit, or
 * failure. There is no code path that produces an artifact without one, and
 * this is the authoritative per-production provenance record when a
 * content-addressed artifact dedups (see brain/README.md).
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Confidence } from "./artifact.ts";
import type { Usage } from "./provider.ts";

export type RunStatus =
  | "ok"
  | "cache_hit"
  /** A long-running job is in flight; carries the external job id so a crashed
   *  run can be traced (and, later, re-attached) rather than silently redone. */
  | "running"
  | "retry"
  | "schema_invalid"
  | "provider_error"
  | "provider_refusal"
  | "failed";

export interface RunRecord {
  run_id: string;
  graph_id?: string | null;
  node_id?: string | null;
  transformation: string;
  transformation_version: string;
  /** Input artifact ids — never values; the store holds the content. */
  inputs: string[];
  output: string | null;
  status: RunStatus;
  attempt: number;
  max_attempts: number;
  provider?: string | null;
  model?: string | null;
  /** Pinned prompt version, so a later edit cannot reinterpret this run. */
  prompt_ref?: string | null;
  usage?: Usage | null;
  confidence?: Confidence | null;
  started_at: string;
  duration_ms: number;
  error?: string | null;
  /**
   * External job identifier for a long-running transformation (a render, say).
   * Recorded while the job is in flight so a crashed run leaves a trace of what
   * it had started, instead of silently re-doing twenty minutes of work.
   */
  external_job_id?: string | null;
  /** Human-readable progress note, only on `running` records. */
  detail?: string | null;
}

export interface RunLog {
  record(r: RunRecord): Promise<void>;
  all(): Promise<RunRecord[]>;
}

/** In-memory, for tests. */
export class MemoryRunLog implements RunLog {
  readonly records: RunRecord[] = [];
  async record(r: RunRecord): Promise<void> {
    this.records.push(r);
  }
  async all(): Promise<RunRecord[]> {
    return [...this.records];
  }
}

/** Append-only JSONL. Postgres replaces this behind the same interface. */
export class JsonlRunLog implements RunLog {
  constructor(private readonly file: string) { }

  async record(r: RunRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(r)}\n`, "utf8");
  }

  async all(): Promise<RunRecord[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunRecord);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

/** Cost rollup for an episode or a whole graph run (RFC 0006 §3). */
export function rollup(records: RunRecord[]): {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  by_transformation: Record<string, { cost_usd: number; calls: number }>;
} {
  const by: Record<string, { cost_usd: number; calls: number }> = {};
  let cost = 0;
  let inTok = 0;
  let outTok = 0;
  for (const r of records) {
    const c = r.usage?.cost_usd ?? 0;
    cost += c;
    inTok += r.usage?.input_tokens ?? 0;
    outTok += r.usage?.output_tokens ?? 0;
    const slot = (by[r.transformation] ??= { cost_usd: 0, calls: 0 });
    slot.cost_usd += c;
    slot.calls += 1;
  }
  return {
    cost_usd: Number(cost.toFixed(6)),
    input_tokens: inTok,
    output_tokens: outTok,
    by_transformation: by,
  };
}
