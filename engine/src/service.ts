/**
 * Application service.
 *
 * Assembles the engine for a single local operator and exposes the handful of
 * operations a UI needs: start a run, watch which step is executing, review a
 * gated artifact, approve or reject it, and manage credentials.
 *
 * Providers are rebuilt whenever credentials change, so a key entered in the UI
 * takes effect on the next run without a restart.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { SchemaRegistry } from "./registry.ts";
import { PromptStore } from "./prompts.ts";
import { FsArtifactStore, type ArtifactStore } from "./store.ts";
import { FsBlobStore, type BlobStore } from "./blobs.ts";
import { JsonlRunLog, rollup, type RunLog, type RunRecord } from "./runlog.ts";
import { hasDatabase, getPool, migrate } from "./db.ts";
import { PgRunLog } from "./pg-runlog.ts";
import { markRunForCleanup, sweepBlobs } from "./cleanup.ts";
import {
  ProviderRouter,
  type ImageProvider,
  type MediaRenderer,
  type PublishTarget,
  type SpeechProvider,
} from "./provider.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { ElevenLabsProvider } from "./providers/elevenlabs.ts";
import { StockImageProvider } from "./providers/stock.ts";
import { ComposeRenderer } from "./providers/compose.ts";
import { YouTubeTarget } from "./providers/youtube.ts";
import { youtubeTokenFactory } from "./youtube-auth.ts";
import {
  FakeImageProvider,
  FakePublishTarget,
  FakeRenderer,
  FakeSpeechProvider,
} from "./providers/fake.ts";
import { Runner, type TransformationDef } from "./runner.ts";
import { loadAgentDefs, validateCatalog } from "./catalog.ts";
import { allTransformations, defaultWorkers } from "./workers/index.ts";
import { loadGraph, nodeType, inputsOf, type GraphDoc } from "./graph.ts";
import {
  GraphExecutor,
  type ExecutorEvent,
  type GateDecision,
  type GraphRunResult,
} from "./executor.ts";
import { validateGraph } from "./graph.ts";
import { credentialStatus, readEnvFile, writeEnvFile, type CredentialStatus } from "./config.ts";

export type NodeState = "pending" | "running" | "done" | "waiting" | "failed" | "blocked";

export interface NodeView {
  node_id: string;
  kind: "input" | "transformation" | "human_gate";
  transformation: string | null;
  state: NodeState;
  artifact_id: string | null;
  /** Only for a waiting gate. */
  reason?: string;
  error?: string;
}

export interface RunView {
  run_id: string;
  graph: string;
  brief: string;
  status: GraphRunResult["status"] | "running";
  created_at: string;
  nodes: NodeView[];
  cost_usd: number;
  waiting: Array<{ node_id: string; artifact_id: string; reason: string }>;
  failures: Array<{ node_id: string; error: string }>;
}

interface RunState {
  runId: string;
  brief: string;
  createdAt: string;
  /** Node ids currently executing — the "which step is running" signal. */
  active: Set<string>;
  /** Incrementally tracks node completions from executor events. */
  completedOutputs: Map<string, string>;
  last: GraphRunResult | null;
  finished: boolean;
  error: string | null;
}

export interface ServiceOptions {
  root: string;
  dataDir?: string;
  envFile?: string;
  /** Publishing for real requires an explicit opt-in, never just a token. */
  allowPublish?: boolean;
}

export class VidGenService {
  private registry!: SchemaRegistry;
  private prompts!: PromptStore;
  private agents!: Map<string, TransformationDef>;
  private graph!: GraphDoc;
  private store!: ArtifactStore;
  private blobs!: BlobStore;
  private runLog!: RunLog;
  private executor!: GraphExecutor;
  private transformations!: Map<string, TransformationDef>;

  private readonly runs = new Map<string, RunState>();
  readonly envFile: string;
  private readonly dataDir: string;
  private allowPublish: boolean;

  private constructor(private readonly root: string, opts: ServiceOptions) {
    this.dataDir = opts.dataDir ?? path.join(root, ".vidgen-data");
    this.envFile = opts.envFile ?? path.join(root, ".env");
    this.allowPublish = opts.allowPublish ?? false;
  }

  static async create(opts: ServiceOptions): Promise<VidGenService> {
    const svc = new VidGenService(opts.root, opts);
    for (const [k, v] of Object.entries(await readEnvFile(svc.envFile))) {
      if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
    }
    svc.registry = await SchemaRegistry.load(path.join(opts.root, "schemas"));
    svc.prompts = await PromptStore.load(path.join(opts.root, "prompts"));
    svc.agents = (await loadAgentDefs(path.join(opts.root, "agents"))) as Map<
      string,
      TransformationDef
    >;
    validateCatalog(svc.agents as never, {
      hasSchema: (id) => svc.registry.has(id),
      hasPrompt: (ref) => svc.prompts.has(ref),
    });
    svc.graph = await loadGraph(path.join(opts.root, "graphs", "skeleton.json"));
    svc.store = await FsArtifactStore.open(svc.dataDir, svc.registry);
    svc.blobs = await FsBlobStore.open(svc.dataDir);

    // Use Postgres when DATABASE_URL is set, filesystem otherwise.
    if (hasDatabase()) {
      await migrate();
      const pool = getPool();
      svc.runLog = new PgRunLog(pool);
      console.log("[db] using Postgres for run persistence");
    } else {
      svc.runLog = new JsonlRunLog(path.join(svc.dataDir, "runs.jsonl"));
    }

    svc.rebuild();
    await svc.reloadRuns();
    return svc;
  }

  /** Rebuild providers and the executor from the current environment. */
  private rebuild(): void {
    const env = (k: string) => {
      const v = process.env[k];
      return v && v.trim() ? v.trim() : undefined;
    };

    const speech: SpeechProvider = env("ELEVENLABS_API_KEY")
      ? new ElevenLabsProvider({ apiKey: env("ELEVENLABS_API_KEY")! })
      : new FakeSpeechProvider();
    const images: ImageProvider = (env("PEXELS_API_KEY") || env("UNSPLASH_ACCESS_KEY"))
      ? new StockImageProvider()
      : new FakeImageProvider();
    const renderer: MediaRenderer = env("COMPOSE_URL")
      ? new ComposeRenderer({ baseUrl: env("COMPOSE_URL")! })
      : new FakeRenderer();
    const target: PublishTarget =
      this.allowPublish && env("YOUTUBE_CLIENT_ID") && env("YOUTUBE_CLIENT_SECRET") && env("YOUTUBE_REFRESH_TOKEN")
        ? new YouTubeTarget({
          accessToken: youtubeTokenFactory({
            clientId: env("YOUTUBE_CLIENT_ID")!,
            clientSecret: env("YOUTUBE_CLIENT_SECRET")!,
            refreshToken: env("YOUTUBE_REFRESH_TOKEN")!,
          }),
        })
        : this.allowPublish && env("YOUTUBE_ACCESS_TOKEN")
          ? new YouTubeTarget({ accessToken: env("YOUTUBE_ACCESS_TOKEN")! })
          : new FakePublishTarget({ id: "dry-run" });

    this.transformations = allTransformations(
      this.agents,
      defaultWorkers({
        voice: { voiceId: env("ELEVENLABS_VOICE_ID") ?? "smoke-voice" },
        publish: { target, privacy: "private" },
      }),
    );
    validateGraph(this.graph, { registry: this.registry, transformations: this.transformations });

    const providers = new ProviderRouter({
      reasoning_high: new AnthropicProvider({ model: "claude-opus-5", effort: "high" }),
      reasoning_fast: new AnthropicProvider({ model: "claude-sonnet-5", effort: "medium" }),
    });

    const runner = new Runner({
      store: this.store,
      registry: this.registry,
      prompts: this.prompts,
      providers,
      runLog: this.runLog,
      blobs: this.blobs,
      media: { speech, images, renderer },
      logger: console,
    });

    this.executor = new GraphExecutor({
      runner,
      runLog: this.runLog,
      store: this.store,
      registry: this.registry,
      transformations: this.transformations,
      onEvent: (e) => this.onExecutorEvent(e),
    });
  }

  /** Reload runs from the run log so they survive container restarts. */
  private async reloadRuns(): Promise<void> {
    const records = await this.runLog.all();
    // Group records by run_id
    const byRun = new Map<string, RunRecord[]>();
    for (const r of records) {
      const list = byRun.get(r.run_id) ?? [];
      list.push(r);
      byRun.set(r.run_id, list);
    }

    for (const [runId, recs] of byRun) {
      if (this.runs.has(runId)) continue; // already in memory
      // Find the intent (first record) to get the brief
      const intentRec = recs.find(r => r.transformation === "human" && r.node_id === "intent");
      // Derive brief from the intent artifact if possible
      let brief = runId;
      if (intentRec?.output) {
        try {
          const art = await this.store.get(intentRec.output);
          if (art && typeof art === "object" && "payload" in (art as any)) {
            brief = (art as any).payload?.brief ?? runId;
          }
        } catch { /* use runId as fallback */ }
      }

      // Check if the run completed or has failures
      const completedOutputs = new Map<string, string>();
      let hasFailure = false;
      for (const r of recs) {
        if (r.node_id && r.output && (r.status === "ok" || r.status === "cache_hit")) {
          completedOutputs.set(r.node_id, r.output);
        }
        if (r.status === "failed" || r.status === "provider_error") {
          hasFailure = true;
        }
      }

      const allDone = completedOutputs.size === this.graph.nodes.length;

      this.runs.set(runId, {
        runId,
        brief,
        createdAt: recs[0]?.started_at ?? new Date().toISOString(),
        active: new Set(),
        completedOutputs,
        last: {
          run_id: runId,
          graph: `${this.graph.graph_id}@${this.graph.version}`,
          status: allDone ? "completed" : hasFailure ? "blocked" : "waiting",
          outputs: Object.fromEntries(completedOutputs),
          waiting: [],
          failures: hasFailure
            ? recs.filter(r => r.status === "failed" && r.node_id).map(r => ({
              node_id: r.node_id!,
              transformation: r.transformation,
              error: r.error ?? "unknown error",
            }))
            : [],
          blocked: [],
        },
        finished: true,
        error: null,
      });
    }
    if (byRun.size > 0) {
      console.log(`[startup] reloaded ${byRun.size} run(s) from disk`);
    }
  }

  private onExecutorEvent(e: ExecutorEvent): void {
    const state = this.runs.get(e.run_id);
    if (!state) return;
    const tag = `[run ${e.run_id.slice(4, 12)}]`;
    if (e.type === "node_start") {
      state.active.add(e.node_id);
      console.log(`${tag} ▶ ${e.node_id} (${e.transformation})`);
    }
    if (e.type === "node_done" || e.type === "node_failed") {
      state.active.delete(e.node_id);
    }
    if (e.type === "node_done") {
      state.completedOutputs.set(e.node_id, e.artifact_id);
      console.log(`${tag} ✓ ${e.node_id}${e.cached ? " (cached)" : ""}`);
    }
    if (e.type === "node_failed") {
      console.error(`${tag} ✗ ${e.node_id} — ${e.error}`);
    }
    if (e.type === "gate_waiting") {
      console.log(`${tag} ⏸ ${e.node_id} — ${e.reason}`);
    }
    if (e.type === "gate_settled" && e.approved) {
      // Gate approvals are identity pass-throughs — find the upstream artifact
      // from the last result's outputs (the gate's input node).
      const gateNode = this.graph.nodes.find(n => n.id === e.node_id);
      const upstreamId = gateNode ? (inputsOf(gateNode)[0] ?? null) : null;
      const upstreamArtifact = upstreamId
        ? (state.last?.outputs?.[upstreamId] ?? state.completedOutputs.get(upstreamId) ?? null)
        : null;
      if (upstreamArtifact) {
        state.completedOutputs.set(e.node_id, upstreamArtifact);
      }
      console.log(`${tag} ✓ ${e.node_id} (gate approved)`);
    }
    if (e.type === "run_end") {
      console.log(`${tag} ■ ${e.status}`);
    }
  }

  // -- providers / credentials -------------------------------------------

  providerSummary(): Array<{ role: string; provider: string; real: boolean }> {
    const env = (k: string) => Boolean(process.env[k]?.trim());
    return [
      { role: "reasoning", provider: "anthropic/claude-opus-5", real: env("ANTHROPIC_API_KEY") },
      { role: "speech", provider: env("ELEVENLABS_API_KEY") ? "elevenlabs" : "fake", real: env("ELEVENLABS_API_KEY") },
      { role: "images", provider: (env("PEXELS_API_KEY") || env("UNSPLASH_ACCESS_KEY")) ? "stock (pexels+unsplash)" : "fake", real: !!(env("PEXELS_API_KEY") || env("UNSPLASH_ACCESS_KEY")) },
      { role: "renderer", provider: env("COMPOSE_URL") ? "long-compose" : "fake", real: env("COMPOSE_URL") },
      {
        role: "publish",
        provider: this.allowPublish && (env("YOUTUBE_REFRESH_TOKEN") || env("YOUTUBE_ACCESS_TOKEN")) ? "youtube" : "dry-run",
        real: this.allowPublish && (env("YOUTUBE_REFRESH_TOKEN") || env("YOUTUBE_ACCESS_TOKEN")),
      },
    ];
  }

  credentials(): CredentialStatus[] {
    return credentialStatus();
  }

  async saveCredentials(updates: Record<string, string>): Promise<string[]> {
    const applied = await writeEnvFile(this.envFile, updates);
    this.rebuild(); // a key entered now takes effect on the next run
    return applied;
  }

  // -- runs ---------------------------------------------------------------

  async startRun(brief: string, durationSec = 540): Promise<string> {
    const trimmed = brief.trim();
    if (trimmed.length < 8) throw new Error("brief is too short");
    if (!process.env["ANTHROPIC_API_KEY"]?.trim()) {
      throw new Error("ANTHROPIC_API_KEY is not set — the reasoning agents cannot run");
    }

    const runId = `run_${randomUUID()}`;
    console.log(`[run ${runId.slice(4, 12)}] starting: "${trimmed}" (${durationSec}s)`);

    // Persist run in Postgres if available
    if (this.runLog instanceof PgRunLog) {
      await this.runLog.createRun(runId, trimmed, `${this.graph.graph_id}@${this.graph.version}`);
    }

    const intent = await this.store.put({
      schema_id: "intent",
      payload: { brief: trimmed, target_duration_sec: durationSec },
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    console.log(`[run ${runId.slice(4, 12)}] intent stored: ${intent.artifact.artifact_id.slice(0, 12)}...`);

    this.runs.set(runId, {
      runId,
      brief: trimmed,
      createdAt: new Date().toISOString(),
      active: new Set(),
      completedOutputs: new Map(),
      last: null,
      finished: false,
      error: null,
    });

    // Kick off in the background: a run takes minutes, and the UI polls.
    void this.drive(runId, () =>
      this.executor.start(this.graph, { intent: intent.artifact.artifact_id }, { runId }),
    );
    return runId;
  }

  async decide(runId: string, nodeId: string, decision: GateDecision): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    void this.drive(runId, () => this.executor.resume(this.graph, runId, { [nodeId]: decision }));
  }

  /** Retry a failed run from where it stopped — completed nodes are preserved. */
  async retry(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    console.log(`[run ${runId.slice(4, 12)}] retrying from failure`);
    void this.drive(runId, () => this.executor.resume(this.graph, runId, {}));
  }

  private async drive(runId: string, fn: () => Promise<GraphRunResult>): Promise<void> {
    const state = this.runs.get(runId)!;
    try {
      state.last = await fn();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      console.error(`[run ${runId.slice(4, 12)}] drive error: ${state.error}`);
    } finally {
      state.active.clear();
      state.finished = true;

      // Persist status to Postgres
      if (this.runLog instanceof PgRunLog) {
        const status = state.error ? "blocked" : (state.last?.status ?? "blocked");
        await this.runLog.updateRunStatus(runId, status, state.error);
        const cost = rollup(await this.runLog.forRun(runId)).cost_usd;
        await this.runLog.updateRunCost(runId, cost);

        // Cleanup: if the run completed, mark intermediate blobs for deletion
        if (status === "completed") {
          const marked = await markRunForCleanup(this.runLog, runId);
          if (marked > 0) {
            console.log(`[run ${runId.slice(4, 12)}] marked ${marked} blobs for cleanup`);
            await sweepBlobs(this.runLog, path.join(this.dataDir, "blobs"));
          }
        }
      }
    }
  }

  listRuns(): RunView[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => this.view(s));
  }

  getRun(runId: string): RunView | null {
    const s = this.runs.get(runId);
    return s ? this.view(s) : null;
  }

  /** Records for one run, so the UI can show cost and the current job. */
  async runRecords(runId: string): Promise<RunRecord[]> {
    if (this.runLog instanceof PgRunLog) {
      return this.runLog.forRun(runId);
    }
    return (await this.runLog.all()).filter((r) => r.run_id === runId);
  }

  async costOf(runId: string): Promise<number> {
    return rollup(await this.runRecords(runId)).cost_usd;
  }

  private view(s: RunState): RunView {
    const outputs = s.last?.outputs ?? {};
    const waitingBy = new Map((s.last?.waiting ?? []).map((w) => [w.node_id, w]));
    const failureBy = new Map((s.last?.failures ?? []).map((f) => [f.node_id, f]));
    const blocked = new Set(s.last?.blocked ?? []);

    const nodes: NodeView[] = this.graph.nodes.map((n) => {
      const kind = nodeType(n);
      // Use both the last settled result AND the live event-driven completions.
      const artifact = outputs[n.id] ?? s.completedOutputs.get(n.id) ?? null;
      let state: NodeState = "pending";
      if (s.active.has(n.id)) state = "running";
      else if (artifact) state = "done";
      else if (s.finished && waitingBy.has(n.id)) state = "waiting";
      else if (s.finished && failureBy.has(n.id)) state = "failed";
      else if (s.finished && blocked.has(n.id)) state = "blocked";

      const wait = s.finished ? waitingBy.get(n.id) : undefined;
      const fail = s.finished ? failureBy.get(n.id) : undefined;
      return {
        node_id: n.id,
        kind,
        transformation:
          kind === "transformation" ? (n as { transformation: string }).transformation : null,
        state,
        artifact_id: artifact,
        ...(wait ? { reason: wait.reason } : {}),
        ...(fail ? { error: fail.error } : {}),
      };
    });

    const status = !s.finished ? "running" : s.error ? "blocked" : (s.last?.status ?? "blocked");

    // While the run is actively executing, the old waiting/failures are stale
    // (the decision that unblocked the run already happened). Only report them
    // when the executor has settled and they represent the current truth.
    const waiting = s.finished ? (s.last?.waiting ?? []) : [];
    const failures = s.finished ? (s.last?.failures ?? []).map((f) => ({ node_id: f.node_id, error: f.error })) : [];

    return {
      run_id: s.runId,
      graph: s.last?.graph ?? `${this.graph.graph_id}@${this.graph.version}`,
      brief: s.brief,
      status,
      created_at: s.createdAt,
      nodes,
      cost_usd: 0, // filled in by the server, which can await
      waiting,
      failures,
    };
  }

  /** Full artifact for review — the script's narration, the story's acts, etc. */
  async artifact(id: string): Promise<unknown> {
    const a = await this.store.get(id);
    if (!a) throw new Error(`unknown artifact ${id}`);
    return a;
  }

  /** Upstream dependency ids for a node, so a gate can show what it is gating. */
  gateSubject(nodeId: string): string | null {
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    return node ? (inputsOf(node)[0] ?? null) : null;
  }

  get graphDoc(): GraphDoc {
    return this.graph;
  }
}
