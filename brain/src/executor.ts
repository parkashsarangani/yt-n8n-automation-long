/**
 * Graph executor (RFC 0005).
 *
 * The brain walks the DAG. n8n does not — if it did, topology would live in
 * node wiring instead of in the versioned graph document, which is the thing
 * RFC 0005 exists to prevent.
 *
 * Run state is derived, not stored as truth: a node is complete iff the run log
 * already records a successful execution of it for this run. Crash recovery is
 * therefore re-deriving readiness, not replaying a journal.
 */

import { randomUUID } from "node:crypto";
import {
  descendantsOf,
  graphRef,
  inputsOf,
  nodeType,
  type GraphDoc,
  type GraphNode,
  type HumanGateNode,
  type InputNode,
  type TransformationNode,
} from "./graph.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { evaluatePredicate } from "./predicate.ts";
import type { SchemaRegistry } from "./registry.ts";
import type { RunLog, RunRecord } from "./runlog.ts";
import type { Runner, TransformationDef } from "./runner.ts";
import type { ArtifactStore } from "./store.ts";

export class ExecutorError extends Error {
  override name = "ExecutorError";
}

export type GraphRunStatus = "completed" | "waiting" | "blocked";

export interface GateWait {
  node_id: string;
  artifact_id: string;
  /** Why a human is being asked: no policy, or the auto-pass predicate failed. */
  reason: string;
}

export interface NodeFailure {
  node_id: string;
  transformation: string;
  error: string;
}

export interface GraphRunResult {
  run_id: string;
  graph: string;
  status: GraphRunStatus;
  outputs: Record<string, string>;
  waiting: GateWait[];
  failures: NodeFailure[];
  /** Nodes not attempted because something upstream failed or is waiting. */
  blocked: string[];
}

/** Live progress, so a UI can show which step is executing (RFC 0006). */
export type ExecutorEvent =
  | { type: "run_start"; run_id: string; graph: string }
  | { type: "node_start"; run_id: string; node_id: string; transformation: string }
  | { type: "node_done"; run_id: string; node_id: string; artifact_id: string; cached: boolean }
  | { type: "node_failed"; run_id: string; node_id: string; error: string }
  | { type: "gate_waiting"; run_id: string; node_id: string; reason: string }
  | { type: "gate_settled"; run_id: string; node_id: string; approved: boolean }
  | { type: "run_end"; run_id: string; status: GraphRunStatus };

export type GateDecision =
  | { result: "approve" }
  | { result: "reject"; reason?: string };

export interface ExecutorDeps {
  runner: Runner;
  runLog: RunLog;
  store: ArtifactStore;
  registry: SchemaRegistry;
  transformations: Map<string, TransformationDef>;
  /** Ready nodes executed concurrently. Bounded so a wide fan-out cannot swamp the host. */
  maxParallel?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Progress sink. Must never throw — a broken listener cannot fail a run. */
  onEvent?: (event: ExecutorEvent) => void;
}

export class GraphExecutor {
  constructor(private readonly deps: ExecutorDeps) { }

  private emit(event: ExecutorEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch (err) {
      this.deps.logger?.warn(`[graph] progress listener threw: ${String(err)}`);
    }
  }

  /** Begin a run. `seeds` maps input node ids to existing artifact ids. */
  async start(
    graph: GraphDoc,
    seeds: Record<string, string>,
    opts: { runId?: string } = {},
  ): Promise<GraphRunResult> {
    const runId = opts.runId ?? `run_${randomUUID()}`;

    for (const node of graph.nodes) {
      if (nodeType(node) !== "input") continue;
      const input = node as InputNode;
      const artifactId = seeds[input.id];
      if (!artifactId) {
        throw new ExecutorError(`graph ${graphRef(graph)} needs a seed for input "${input.id}"`);
      }
      // Validate the seed against its declared schema before anything runs.
      await this.deps.store.require(artifactId, { schema_id: input.schema_id });
      await this.recordNode(runId, graph, input.id, "input", artifactId, "ok");
    }

    return this.drive(graph, runId, {});
  }

  /** Continue a parked run, supplying decisions for any waiting human gates. */
  async resume(
    graph: GraphDoc,
    runId: string,
    decisions: Record<string, GateDecision> = {},
  ): Promise<GraphRunResult> {
    return this.drive(graph, runId, decisions);
  }

  // ------------------------------------------------------------------

  private async drive(
    graph: GraphDoc,
    runId: string,
    decisions: Record<string, GateDecision>,
  ): Promise<GraphRunResult> {
    const ref = graphRef(graph);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const completed = await this.deriveCompleted(runId, ref);

    const failures: NodeFailure[] = [];
    const waiting: GateWait[] = [];
    const stalled = new Set<string>(); // failed or waiting this pass
    const gateRetries = new Map<string, number>(); // rejection count per gate
    this.emit({ type: "run_start", run_id: runId, graph: ref });

    for (; ;) {
      const ready = graph.nodes.filter(
        (n) =>
          !completed.has(n.id) &&
          !stalled.has(n.id) &&
          inputsOf(n).every((up) => completed.has(up)),
      );
      if (ready.length === 0) break;

      // Gates first: they are cheap and may unblock work in the same pass.
      const gates = ready.filter((n) => nodeType(n) === "human_gate");
      const work = ready.filter((n) => nodeType(n) === "transformation");

      for (const node of gates) {
        const gate = node as HumanGateNode;
        const upstreamId = completed.get(inputsOf(gate)[0]!)!;
        const outcome = await this.settleGate(gate, upstreamId, decisions[gate.id]);
        // Consume the decision so it doesn't re-apply on retry loops.
        delete decisions[gate.id];

        if (outcome.kind === "approved") {
          completed.set(gate.id, upstreamId); // identity pass-through
          this.emit({ type: "gate_settled", run_id: runId, node_id: gate.id, approved: true });
          await this.recordNode(runId, graph, gate.id, "human_gate", upstreamId, "ok");
        } else if (outcome.kind === "rejected") {
          // Retry: remove the upstream transformation from completed so it reruns.
          // The gate stays unresolved, and on the next loop iteration the upstream
          // node becomes ready again, producing a fresh artifact for re-evaluation.
          const upstreamNodeId = inputsOf(gate)[0]!;

          // Guard against infinite retries (max 3 rejections per gate per run).
          const retryKey = `${gate.id}_retries`;
          const retries = (gateRetries.get(retryKey) ?? 0) + 1;
          gateRetries.set(retryKey, retries);

          if (retries > 3) {
            stalled.add(gate.id);
            failures.push({ node_id: gate.id, transformation: "human_gate", error: `rejected ${retries} times — giving up` });
            this.emit({ type: "node_failed", run_id: runId, node_id: gate.id, error: `max retries exceeded` });
          } else {
            completed.delete(upstreamNodeId);
            completed.delete(gate.id);
            this.emit({ type: "gate_settled", run_id: runId, node_id: gate.id, approved: false });
            await this.recordNode(runId, graph, gate.id, "human_gate", null, "retry", outcome.reason);
            this.deps.logger?.log(
              `[graph ${ref}] gate "${gate.id}" rejected (${retries}/3) — retrying "${upstreamNodeId}"`,
            );
          }
        } else {
          stalled.add(gate.id);
          waiting.push({ node_id: gate.id, artifact_id: upstreamId, reason: outcome.reason });
          this.emit({
            type: "gate_waiting",
            run_id: runId,
            node_id: gate.id,
            reason: outcome.reason,
          });
        }
      }

      if (work.length === 0) continue;

      // Edges are the only parallelism declaration: anything ready runs together.
      const results = await mapWithConcurrency(
        work,
        this.deps.maxParallel ?? 3,
        async (node) => {
          const tn = node as TransformationNode;
          this.emit({
            type: "node_start",
            run_id: runId,
            node_id: tn.id,
            transformation: tn.transformation,
          });
          return this.runNode(graph, runId, tn, completed);
        },
      );

      for (const [i, r] of results.entries()) {
        const node = work[i]!;
        if (r.ok) {
          completed.set(node.id, r.artifactId);
          this.emit({
            type: "node_done",
            run_id: runId,
            node_id: node.id,
            artifact_id: r.artifactId,
            cached: false,
          });
        } else {
          stalled.add(node.id);
          failures.push({
            node_id: node.id,
            transformation: (node as TransformationNode).transformation,
            error: r.error,
          });
          this.emit({ type: "node_failed", run_id: runId, node_id: node.id, error: r.error });
          this.deps.logger?.warn(`[graph ${ref}] node "${node.id}" failed: ${r.error}`);
        }
      }
    }

    // Anything downstream of a stalled node was never attempted.
    const blocked = [...descendantsOf(graph, stalled)].filter(
      (id) => !completed.has(id) && !stalled.has(id) && byId.has(id),
    );

    const status: GraphRunStatus =
      failures.length > 0
        ? "blocked"
        : waiting.length > 0
          ? "waiting"
          : completed.size === graph.nodes.length
            ? "completed"
            : "blocked";

    this.emit({ type: "run_end", run_id: runId, status });

    return {
      run_id: runId,
      graph: ref,
      status,
      outputs: Object.fromEntries(completed),
      waiting,
      failures,
      blocked,
    };
  }

  private async settleGate(
    gate: HumanGateNode,
    upstreamId: string,
    decision: GateDecision | undefined,
  ): Promise<
    { kind: "approved" } | { kind: "rejected"; reason: string } | { kind: "waiting"; reason: string }
  > {
    if (decision) {
      return decision.result === "approve"
        ? { kind: "approved" }
        : { kind: "rejected", reason: decision.reason ?? "rejected at human gate" };
    }
    const predicate = gate.policy?.auto_pass_if;
    if (!predicate) {
      return { kind: "waiting", reason: "human approval required" };
    }
    const artifact = await this.deps.store.require(upstreamId);
    return evaluatePredicate(predicate, artifact)
      ? { kind: "approved" }
      : { kind: "waiting", reason: `auto-pass predicate not met: ${predicate}` };
  }

  private async runNode(
    graph: GraphDoc,
    runId: string,
    node: TransformationNode,
    completed: Map<string, string>,
  ): Promise<{ ok: true; artifactId: string } | { ok: false; error: string }> {
    const def = this.deps.transformations.get(node.transformation);
    if (!def) {
      return { ok: false, error: `unknown transformation "${node.transformation}"` };
    }
    const inputIds = inputsOf(node).map((up) => completed.get(up)!);

    // Cross-run reuse is opt-in (RFC 0005): agents are not cached by default,
    // because re-running is how variants happen.
    if (node.reuse) {
      const prior = await this.findReusable(def, inputIds);
      if (prior) {
        await this.recordNode(
          runId,
          graph,
          node.id,
          node.transformation,
          prior,
          "cache_hit",
          null,
          def.version ?? "1",
          inputIds,
        );
        return { ok: true, artifactId: prior };
      }
    }

    try {
      const out = await this.deps.runner.run(def, inputIds, {
        runId,
        graphId: graphRef(graph),
        nodeId: node.id,
        ...(node.labels ? { labels: node.labels } : {}),
      });
      return { ok: true, artifactId: out.artifact.artifact_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A previous successful execution of this transformation over these inputs. */
  private async findReusable(
    def: TransformationDef,
    inputIds: string[],
  ): Promise<string | null> {
    const version = def.version ?? "1";
    const records = await this.deps.runLog.all();
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      if (r.transformation !== def.name) continue;
      if (r.transformation_version !== version) continue;
      if (!r.output) continue;
      if (r.status !== "ok" && r.status !== "cache_hit") continue;
      if (r.inputs.length !== inputIds.length) continue;
      if (r.inputs.some((id, j) => id !== inputIds[j])) continue;
      return r.output;
    }
    return null;
  }

  /** Nodes already completed for this run, from the run log (last success wins). */
  private async deriveCompleted(runId: string, ref: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const retried = new Set<string>();
    const records = await this.deps.runLog.all();
    // Scan in order: a "retry" record invalidates the prior success for that node.
    for (const r of records) {
      if (r.run_id !== runId || r.graph_id !== ref || !r.node_id) continue;
      if (r.status === "retry") {
        // The upstream was rejected — any prior completion for the upstream is invalid.
        retried.add(r.node_id);
        out.delete(r.node_id);
        continue;
      }
      if (!r.output) continue;
      if (r.status !== "ok" && r.status !== "cache_hit") continue;
      out.set(r.node_id, r.output);
      retried.delete(r.node_id); // a new success after a retry is valid
    }
    return out;
  }

  private async recordNode(
    runId: string,
    graph: GraphDoc,
    nodeId: string,
    transformation: string,
    output: string | null,
    status: RunRecord["status"],
    error: string | null = null,
    version = "1",
    inputs: string[] = [],
  ): Promise<void> {
    await this.deps.runLog.record({
      run_id: runId,
      graph_id: graphRef(graph),
      node_id: nodeId,
      transformation,
      transformation_version: version,
      inputs,
      output,
      status,
      attempt: 1,
      max_attempts: 1,
      started_at: new Date().toISOString(),
      duration_ms: 0,
      error,
    });
  }
}

