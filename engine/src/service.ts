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
import { socialSeriesEpisode } from "./social-series.ts";
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
  type AnalyticsProvider,
  type ImageProvider,
  type MediaRenderer,
  type PublishTarget,
  type SpeechProvider,
} from "./provider.ts";
import { OpenAIProvider, scriptAuthoringModel } from "./providers/openai.ts";
import { ElevenLabsProvider } from "./providers/elevenlabs.ts";
import { FalImageProvider } from "./providers/fal.ts";
import { ComposeRenderer } from "./providers/compose.ts";
import { YouTubeTarget } from "./providers/youtube.ts";
import { YouTubeAnalyticsProvider } from "./providers/youtube-analytics.ts";
import { youtubeTokenFactory } from "./youtube-auth.ts";
import { DriveProvider, type DriveExchange } from "./providers/drive.ts";
import { driveTokenFactory } from "./drive-auth.ts";
import { assertYouTubeProductionGeometry } from "./media/mp4.ts";
import {
  FakeImageProvider,
  FakePublishTarget,
  FakeRenderer,
  FakeSpeechProvider,
  FakeDriveProvider,
} from "./providers/fake.ts";
import { Runner, type TransformationDef } from "./runner.ts";
import { loadAgentDefs, validateCatalog } from "./catalog.ts";
import { allTransformations, defaultWorkers } from "./workers/index.ts";
import { assessWatchability, MAX_ATTEMPTS_BEFORE_ACCEPTING } from "./workers/watchability-release.ts";
import { watchabilityProfile } from "./watchability-policy.ts";
import {
  WatchabilityLedger,
  watchabilityEvaluator,
  watchabilityFingerprint,
  type WatchabilityFingerprintInput,
} from "./watchability-ledger.ts";
import type { TransformationNode } from "./graph.ts";
import { isPackageContractFailureMessage } from "./growth-package-contract.ts";
import { isEditorCutFilename, isEditorThumbnailFilename, isPipelineAuthoredFile } from "./workers/editor-package.ts";
import { sendOperatorAlert } from "./operator-alerts.ts";
import { isModerationReviewFailureMessage } from "./moderation/tts-policy.ts";
import { loadGraph, nodeType, inputsOf, type GraphDoc } from "./graph.ts";
import { buildPerformanceWindow, excludedIds } from "./performance-window.ts";
import { buildTopicHistory } from "./topic-history.ts";
import { buildManualEpisode, type ManualScriptInput } from "./manual-script.ts";
import { Scheduler, type Job, type JobStatus } from "./scheduler.ts";
import { localHourToUtcHour } from "./timezone-hour.ts";
import {
  GraphExecutor,
  type ExecutorEvent,
  type GateDecision,
  type GraphRunResult,
} from "./executor.ts";
import { validateGraph } from "./graph.ts";
import { packageSeedOf, type DiscoveryCandidate, type PackageSeed } from "./growth-scheduler.ts";
import {
  credentialStatus,
  readEnvFile,
  writeEnvFile,
  type CredentialStatus,
  type EnvWriteResult,
} from "./config.ts";
import {
  STAGES,
  capabilityReport,
  credentialsSatisfied,
  type StageStatus,
} from "./capabilities.ts";

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

/**
 * What kind of work a run was.
 *
 * Measurement runs outnumber production runs by an order of magnitude — one per
 * public episode per day, forever — so a flat list buries the handful of runs
 * that made a video. Classifying them lets the UI default to the ones an
 * operator is actually looking for without discarding the rest.
 */
export type RunKind = "production" | "measure" | "discover" | "other";

export interface RunView {
  run_id: string;
  graph: string;
  kind: RunKind;
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
  /** The graph this run actually executed, which may not be the current one. */
  graph?: string;
  /** Status as recorded when the run finished. Authoritative over any replay. */
  storedStatus?: RunView["status"];
  /** Node ids currently executing — the "which step is running" signal. */
  active: Set<string>;
  /** Incrementally tracks node completions from executor events. */
  completedOutputs: Map<string, string>;
  /** Pre-authored outputs still available if an early upstream failure is retried in-process. */
  presetOutputs?: Record<string, string>;
  /**
   * The full immutable set of operator-authored preset artifacts for a manual
   * run. Unlike `presetOutputs` (consumed as nodes complete), this is never
   * cleared, so an operator-requested one-shot re-grade can restore every
   * preset — including the reused `voice` — before the retry cascade.
   */
  manualPresetOutputs?: Record<string, string>;
  /** One-shot operator watchability re-grades used on this manual run (max 1). */
  manualWatchabilityRescores?: number;
  last: GraphRunResult | null;
  finished: boolean;
  error: string | null;
}

/** Deterministic guard: an operator gets exactly one re-grade per manual run. */
export const MAX_MANUAL_WATCHABILITY_RESCORES = 1;

/**
 * How many times driveUnattended() will rewrite the script and re-check
 * moderation after a "review" (non-"block") pre-TTS verdict before giving up
 * and alerting an operator instead of retrying forever.
 */
export const MAX_MODERATION_REVIEW_ATTEMPTS = 3;

export interface ServiceOptions {
  root: string;
  dataDir?: string;
  envFile?: string;
  /** Publishing for real requires an explicit opt-in, never just a token. */
  allowPublish?: boolean;
}

type Genre = "moral_story" | "drama" | "true_story" | "short_story";

/** The operator-selectable knobs from the active intent@2.x schema. */
export interface RunOptions {
  niche?: "practical-social-intelligence";
  seriesEpisode?: number;
  genre?: Genre;
  /**
   * The discovery-tournament winner, passed as typed data on intent rather
   * than smuggled into the brief text. RFC 0009 decision 1 requires production
   * to BEGIN from the already-selected package; a prose brief the packager has
   * to parse is a contract it can silently ignore -- and did, because the
   * marker the scheduler wrote never matched the one the prompt read.
   */
  packageSeed?: PackageSeed;
}

export class VidGenService {
  private registry!: SchemaRegistry;
  private prompts!: PromptStore;
  private agents!: Map<string, TransformationDef>;
  private graph!: GraphDoc;
  private measureGraph!: GraphDoc;
  private discoverGraph!: GraphDoc;
  private scheduler: Scheduler | undefined;
  private store!: ArtifactStore;
  private blobs!: BlobStore;
  private runLog!: RunLog;
  private executor!: GraphExecutor;
  private transformations!: Map<string, TransformationDef>;
  /** The single in-flight editor-return pass, so a webhook cannot race the poll. */
  private editorReturnsInFlight: Promise<{ checked: number; advanced: number }> | null = null;

  /** Marks a returned cut as handed to publish, durably. See editorReturnState(). */
  private static readonly EDITOR_RETURN_MARKER = "editor_return";

  /** Held so measureAll can check live visibility before spending a call. */
  private analyticsProvider: AnalyticsProvider | undefined;
  /** Held so the editor-watch scheduler job can list/download from the run's Drive folder. */
  private driveProvider: DriveExchange | undefined;

  private readonly runs = new Map<string, RunState>();
  readonly envFile: string;
  private readonly dataDir: string;
  private allowPublish: boolean;
  private ledger!: WatchabilityLedger;

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
    // The single publish-capable graph. Manual story/script authoring is an
    // input mode of this same graph, not a second production topology.
    svc.graph = await loadGraph(path.join(opts.root, "graphs", "illustrated_story.json"));
    svc.measureGraph = await loadGraph(path.join(opts.root, "graphs", "measure.json"));
    svc.discoverGraph = await loadGraph(path.join(opts.root, "graphs", "discover.json"));
    svc.store = await FsArtifactStore.open(svc.dataDir, svc.registry);
    svc.blobs = await FsBlobStore.open(svc.dataDir);
    svc.ledger = await WatchabilityLedger.open(svc.dataDir);

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

    // Whether a stage runs for real is decided in exactly one place
    // (capabilities.ts) so this and providerSummary() cannot disagree.
    const can = (id: string): boolean => {
      const spec = STAGES.find((s) => s.id === id);
      if (!spec) throw new Error(`unknown stage ${id}`);
      return credentialsSatisfied(spec);
    };

    const speech: SpeechProvider = can("speech")
      ? new ElevenLabsProvider({ apiKey: env("ELEVENLABS_API_KEY")! })
      : new FakeSpeechProvider();
    const images: ImageProvider = can("images")
      ? new FalImageProvider({
        apiKey: env("FAL_KEY")!,
        ...(env("FAL_MODEL") ? { model: env("FAL_MODEL") } : {}),
        ...(env("FAL_PRICE_PER_IMAGE") ? { pricePerImage: Number(env("FAL_PRICE_PER_IMAGE")) } : {}),
      })
      : new FakeImageProvider();
    const renderer: MediaRenderer = can("renderer")
      ? new ComposeRenderer({ baseUrl: env("COMPOSE_URL")! })
      : new FakeRenderer();
    const drive: DriveExchange = can("editor_handoff")
      ? new DriveProvider({
        accessToken: driveTokenFactory({
          clientId: env("DRIVE_CLIENT_ID")!,
          clientSecret: env("DRIVE_CLIENT_SECRET")!,
          refreshToken: env("DRIVE_REFRESH_TOKEN")!,
        }),
      })
      : new FakeDriveProvider();
    this.driveProvider = drive;

    // The OAuth trio is preferred: it refreshes itself. The bare access token
    // is the one-hour stopgap, and only used when the trio is incomplete.
    const hasOauthTrio =
      env("YOUTUBE_CLIENT_ID") && env("YOUTUBE_CLIENT_SECRET") && env("YOUTUBE_REFRESH_TOKEN");

    // Measurement is read-only, so it is deliberately NOT behind allowPublish —
    // that switch exists to stop accidental uploads, not to stop reading.
    const analytics = can("analytics")
      ? new YouTubeAnalyticsProvider({
        accessToken: youtubeTokenFactory({
          clientId: env("YOUTUBE_CLIENT_ID")!,
          clientSecret: env("YOUTUBE_CLIENT_SECRET")!,
          refreshToken: env("YOUTUBE_REFRESH_TOKEN")!,
        }),
      })
      : undefined;
    this.analyticsProvider = analytics;
    const target: PublishTarget = !(this.allowPublish && can("publish"))
      ? new FakePublishTarget({ id: "dry-run" })
      : hasOauthTrio
        ? new YouTubeTarget({
          accessToken: youtubeTokenFactory({
            clientId: env("YOUTUBE_CLIENT_ID")!,
            clientSecret: env("YOUTUBE_CLIENT_SECRET")!,
            refreshToken: env("YOUTUBE_REFRESH_TOKEN")!,
          }),
        })
        : new YouTubeTarget({ accessToken: env("YOUTUBE_ACCESS_TOKEN")! });

    this.transformations = allTransformations(
      this.agents,
      defaultWorkers({
        voice: { voiceId: env("ELEVENLABS_VOICE_ID") ?? "smoke-voice" },
        // Public by operator decision -- except a failing qa_report, which
        // publish.ts downgrades to private regardless of this default (real
        // production evidence: an episode with missing scenes went public
        // unattended before that existed).
        publish: { target, privacy: "public" },
        editorPackage: { rootFolderId: env("DRIVE_ROOT_FOLDER_ID") },
      }),
    );
    validateGraph(this.graph, { registry: this.registry, transformations: this.transformations });

    // Every reasoning capability resolves to OpenAIProvider, which is free-first:
    // requests walk the ordered free FreeLLMAPI chain and only fall through to
    // paid OpenAI (Astra for editorial reasoning, Luna for routine stages)
    // when the free chain is exhausted OR the agent
    // sets model.prefer_paid_reasoning (a spend-authorizing judge/reviser whose
    // quality bar is calibrated to the paid model). It's a capability, not a
    // vendor/model (RFC 0004).
    const providers = new ProviderRouter({
      reasoning_high: new OpenAIProvider({ effort: "high", model: scriptAuthoringModel() }),
      reasoning_fast: new OpenAIProvider({ effort: "low", model: "gpt-5.6-luna" }),
      // Audio-first: the script is the product. It is authored on OpenAI's
      // strongest model (GPT-6 Astra by default, SCRIPT_MODEL to override); the
      // agent still sets prefer_paid_reasoning so the draft goes there directly
      // instead of walking the free chain first.
      reasoning_script: new OpenAIProvider({ effort: "high", model: scriptAuthoringModel() }),
    });

    const runner = new Runner({
      store: this.store,
      registry: this.registry,
      prompts: this.prompts,
      providers,
      runLog: this.runLog,
      blobs: this.blobs,
      media: { speech, images, renderer, drive, ...(analytics ? { analytics } : {}) },
      logger: console,
    });

    this.executor = new GraphExecutor({
      runner,
      runLog: this.runLog,
      store: this.store,
      registry: this.registry,
      transformations: this.transformations,
      onEvent: (e) => this.onExecutorEvent(e),
      canonicalOutputFor: (node, inputIds) => this.resolveCanonicalWatchability(node, inputIds),
    });
  }

  /** Critic evaluator fingerprint from the current watchability_critic agent. */
  private watchabilityEvaluatorFingerprint(): ReturnType<typeof watchabilityEvaluator> {
    const critic = this.agents.get("watchability_critic") as
      | { prompt: string; model: { capability: string; effort?: string; prefer_paid_reasoning?: boolean } }
      | undefined;
    return watchabilityEvaluator(critic ?? { prompt: "watchability_critic@?", model: { capability: "reasoning_high" } });
  }

  /**
   * Build the watchability fingerprint for a run from its immutable script +
   * intent artifacts. Returns null when either is missing.
   */
  private async watchabilityFingerprintInput(scriptArtifactId?: string, intentArtifactId?: string): Promise<WatchabilityFingerprintInput | null> {
    if (!scriptArtifactId || !intentArtifactId) return null;
    const intent = await this.store.get<{ target_duration_sec?: unknown }>(intentArtifactId).catch(() => null);
    const dur = typeof intent?.payload?.target_duration_sec === "number" ? intent.payload.target_duration_sec : null;
    const profile = watchabilityProfile(dur);
    return {
      script_artifact_id: scriptArtifactId,
      evaluator: this.watchabilityEvaluatorFingerprint(),
      // Mode plus the exact numeric grading surface: two runs share a
      // fingerprint only when the deterministic gate would grade them identically.
      duration_profile: `${profile.mode}:${dur ?? "none"}:avg${profile.averageThreshold}:f30${profile.thresholds.first_30_fidelity}:susp${profile.thresholds.suspense}`,
    };
  }

  private async resolveCanonicalWatchability(node: TransformationNode, inputIds: string[]): Promise<string | null> {
    if (node.transformation !== "watchability_critic") return null;
    // watchability_report consumes [approve_story, draft_script, package_release, intent].
    let scriptId: string | undefined;
    let intentId: string | undefined;
    for (const id of inputIds) {
      const art = await this.store.get(id).catch(() => null);
      if (art?.schema_id === "script") scriptId = id;
      else if (art?.schema_id === "intent") intentId = id;
    }
    const fpInput = await this.watchabilityFingerprintInput(scriptId, intentId);
    if (!fpInput) return null;
    const entry = await this.ledger.get(watchabilityFingerprint(fpInput));
    return entry?.canonical_report_id || null;
  }

  /**
   * Once a run's watchability_release has PASSED, the report that cleared it is
   * the canonical adjudicated decision for its (script + evaluator + profile)
   * fingerprint. First writer wins and it is immutable, so a later run of the
   * identical content reuses it instead of re-rolling the stochastic critic.
   */
  private async recordCanonicalWatchability(runId: string): Promise<void> {
    try {
      const state = this.runs.get(runId);
      if (!state) return;
      const reportId = state.completedOutputs.get("watchability_report");
      const scriptId = state.completedOutputs.get("draft_script");
      const intentId = state.completedOutputs.get("intent");
      if (!reportId) return;
      const fpInput = await this.watchabilityFingerprintInput(scriptId, intentId);
      if (!fpInput) return;
      const entry = await this.ledger.setCanonical(fpInput, reportId, "single");
      if (entry.canonical_report_id === reportId) {
        console.log(`[run ${runId.slice(4, 12)}] watchability decision canonicalised: ${entry.fingerprint} -> ${reportId}`);
      }
    } catch (err) {
      console.warn(`[watchability-ledger] failed to canonicalise for ${runId}: ${String(err)}`);
    }
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

    // The brief is recorded on the run row at creation, so read it from there
    // rather than reconstructing it. The reconstruction below looked for a
    // record with transformation "human", but the executor writes "input" for
    // input nodes — so it never matched, and every reloaded run showed its own
    // id where the topic should be.
    const storedByRun = new Map<string, { brief?: string; graph?: string; status?: string }>();
    if (this.runLog instanceof PgRunLog) {
      try {
        for (const row of await this.runLog.listRuns(500)) {
          storedByRun.set(row.run_id, {
            ...(row.brief ? { brief: row.brief } : {}),
            ...(row.graph_id ? { graph: row.graph_id } : {}),
            ...(row.status ? { status: row.status } : {}),
          });
        }
      } catch { /* fall through to reconstruction */ }
    }

    for (const [runId, recs] of byRun) {
      if (this.runs.has(runId)) continue; // already in memory

      const stored = storedByRun.get(runId);
      let brief = stored?.brief ?? "";
      if (!brief) {
        // Filesystem run log, or a run older than the runs table: recover the
        // brief from the seeded intent artifact. Accepts "input" as well as
        // "human" so this path actually works.
        const intentRec = recs.find(
          (r) =>
            r.node_id === "intent" &&
            (r.transformation === "input" || r.transformation === "human"),
        );
        if (intentRec?.output) {
          try {
            const art = await this.store.get(intentRec.output);
            const payload = (art as { payload?: { brief?: string } } | null)?.payload;
            if (typeof payload?.brief === "string") brief = payload.brief;
          } catch { /* fall through */ }
        }
      }
      // Last resort only: an id is a poor label, but better than blank.
      if (!brief) brief = runId;

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

      // Replaying against the CURRENT graph is wrong for any run that used a
      // different one. Historical graph versions still retain their stored
      // terminal status; node-level details are only reconstructed for the
      // current illustrated production graph.
      const runGraph = stored?.graph ?? `${this.graph.graph_id}@${this.graph.version}`;
      const matchedGraph = `${this.graph.graph_id}@${this.graph.version}` === runGraph ? this.graph : null;
      const allDone = !!matchedGraph && completedOutputs.size === matchedGraph.nodes.length;
      const derived = allDone ? "completed" : hasFailure ? "blocked" : "waiting";
      // A row still marked "running" at reload time is stale by definition:
      // this is a fresh process, so whatever owned that run is gone. Reporting
      // it as running would show phantom work in flight forever.
      const raw = stored?.status;
      const status: GraphRunResult["status"] =
        raw === "completed" || raw === "blocked" || raw === "waiting"
          ? raw
          : raw === "running"
            ? "blocked"
            : derived;

      this.runs.set(runId, {
        runId,
        brief,
        createdAt: recs[0]?.started_at ?? new Date().toISOString(),
        active: new Set(),
        completedOutputs,
        graph: runGraph,
        storedStatus: status,
        last: {
          run_id: runId,
          graph: runGraph,
          status,
          outputs: Object.fromEntries(completedOutputs),
          // Which gate a reloaded run is parked on is derived, not stored, so
          // this used to come back empty and every consumer of `waiting` went
          // blind after a restart -- checkEditorReturns() filters on exactly
          // this, so a returned cut was never picked up for any run that
          // predated the current process, silently, and the engine restarts on
          // every deploy. A gate is waiting when everything it consumes is
          // done and the gate itself is not; it carries the artifact it gates.
          waiting:
            matchedGraph && status === "waiting"
              ? matchedGraph.nodes
                  .filter((n) => nodeType(n) === "human_gate" && !completedOutputs.has(n.id))
                  .filter((n) => inputsOf(n).length > 0 && inputsOf(n).every((dep) => completedOutputs.has(dep)))
                  .map((n) => ({
                    node_id: n.id,
                    artifact_id: completedOutputs.get(inputsOf(n)[0]!)!,
                    reason: "human approval required",
                  }))
              : [],
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
      if (state.presetOutputs?.[e.node_id] === e.artifact_id) delete state.presetOutputs[e.node_id];
      console.log(`${tag} ✓ ${e.node_id}${e.cached ? " (cached)" : ""}`);
      if (e.node_id === "watchability_release") void this.recordCanonicalWatchability(e.run_id);
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
      const gateNode = this.resolveRunGraph(state.graph).nodes.find(n => n.id === e.node_id);
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

  /** Which pipeline stages will do the real thing on the next run, and why not. */
  capabilities(): StageStatus[] {
    return capabilityReport({ allowPublish: this.allowPublish });
  }

  /** Back-compat shape for the startup banner and the existing /api/config. */
  providerSummary(): Array<{ role: string; provider: string; real: boolean }> {
    return this.capabilities().map((s) => ({
      role: s.id,
      provider: s.provider,
      real: s.real,
    }));
  }

  credentials(): CredentialStatus[] {
    return credentialStatus();
  }

  async saveCredentials(updates: Record<string, string>): Promise<EnvWriteResult> {
    const result = await writeEnvFile(this.envFile, updates);
    this.rebuild(); // a key entered now takes effect on the next run
    return result;
  }

  // -- runs ---------------------------------------------------------------

  async startRun(brief: string, durationSec = 540, opts: RunOptions = {}): Promise<string> {
    const series = opts.seriesEpisode !== undefined ? socialSeriesEpisode(opts.seriesEpisode) : undefined;
    if (series && (opts.genre || opts.packageSeed)) throw new Error("series episodes cannot override genre or package seed");
    if (series) brief = `${series.series_title}: ${series.title}. ${series.learning_objective}. Use the structured series context; do not substitute another topic.`;
    const trimmed = brief.trim();
    if (trimmed.length < 8) throw new Error("brief is too short");
    if (!process.env["OPENAI_API_KEY"]?.trim()) {
      throw new Error("OPENAI_API_KEY is not set — the reasoning agents cannot run");
    }

    const runId = `run_${randomUUID()}`;
    console.log(`[run ${runId.slice(4, 12)}] starting: "${trimmed}" (${durationSec}s)${opts.genre ? `, genre=${opts.genre}` : ""}`);

    // Persist run in Postgres if available
    if (this.runLog instanceof PgRunLog) {
      await this.runLog.createRun(runId, trimmed, `${this.graph.graph_id}@${this.graph.version}`);
    }

    const intent = await this.store.put({
      schema_id: "intent",
      payload: {
        brief: trimmed,
        target_duration_sec: durationSec,
        ...(series ? { series } : {}),
        ...((series || opts.niche || !opts.genre) ? { niche: "practical-social-intelligence" } : {}),
        ...(opts.genre ? { genre: opts.genre } : {}),
        ...(opts.packageSeed ? { package_seed: opts.packageSeed } : {}),
      },
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });

    // The feedback loop's entry point. Assembled here rather than in a worker
    // because it is a query across the whole store; seeded as a graph input in
    // the same way as intent. On a channel with nothing measured yet this is a
    // valid, empty window, and the strategist is instructed to return no
    // guidance rather than invent some.
    const window = await buildPerformanceWindow(this.store);
    const performance = await this.store.put({
      schema_id: "performance_window",
      payload: window,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    console.log(
      `[run ${runId.slice(4, 12)}] performance window: ${window.episode_count} measured episode(s)` +
      `${window.episode_count > 0 && !window.ctr_available ? ", no click-through data" : ""}`,
    );
    console.log(`[run ${runId.slice(4, 12)}] intent stored: ${intent.artifact.artifact_id.slice(0, 12)}...`);

    this.runs.set(runId, {
      runId,
      brief: trimmed,
      createdAt: new Date().toISOString(),
      graph: `${this.graph.graph_id}@${this.graph.version}`,
      active: new Set(),
      completedOutputs: new Map(),
      last: null,
      finished: false,
      error: null,
    });

    // Kick off in the background: a run takes minutes, and the UI polls.
    // driveUnattended() self-heals a blocked worker attempt or a blank-scene
    // qa fail without a human clicking "Resume" -- for every run, not only
    // scheduled ones, so a manually-started episode gets the same benefit
    // instead of parking with an avoidable, fixable defect.
    void this.drive(runId, () =>
      this.executor.start(this.graph, { intent: intent.artifact.artifact_id, performance: performance.artifact.artifact_id }, { runId }),
    ).then(() => this.driveUnattended(runId));
    return runId;
  }

  /**
   * Manual narration is an INPUT MODE of illustrated_story, not a second graph.
   * The operator's deterministic story/script artifacts are used as the exact
   * outputs of the existing `story` and `draft_script` nodes. Everything else
   * — strategy/package, watchability evaluation, moderation, TTS, narration,
   * SEO/thumbnail, render, QA and publish — is the same production DAG.
   */
  async startManualRun(
    input: ManualScriptInput,
    durationSec = 540,
    opts: RunOptions & {
      /**
       * Reuse an existing `voice` artifact instead of re-synthesizing TTS.
       * ONLY valid when the operator narration produces a byte-identical
       * `script` artifact to the run that generated this voice (the executor
       * still records real upstream lineage). Operator escape hatch for a
       * spent TTS quota during a diagnostic rerun of an unchanged script.
       */
      reuseVoiceArtifactId?: string;
    } = {},
  ): Promise<string> {
    const episode = buildManualEpisode(input); // throws with a clear message on bad input
    if (!process.env["OPENAI_API_KEY"]?.trim()) {
      throw new Error("OPENAI_API_KEY is not set — the production reasoning agents cannot run");
    }

    const runId = `run_${randomUUID()}`;
    const brief = episode.story.title;
    console.log(`[run ${runId.slice(4, 12)}] starting (manual-script input mode): "${brief}" (${durationSec}s)`);

    if (this.runLog instanceof PgRunLog) {
      await this.runLog.createRun(runId, brief, `${this.graph.graph_id}@${this.graph.version}`);
    }

    const intent = await this.store.put({
      schema_id: "intent",
      payload: {
        brief,
        target_duration_sec: durationSec,
        ...(opts.genre ? { genre: opts.genre } : {}),
        ...(opts.packageSeed ? { package_seed: opts.packageSeed } : {}),
      },
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    const story = await this.store.put({
      schema_id: "story",
      payload: episode.story,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    const script = await this.store.put({
      schema_id: "script",
      payload: episode.script,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    const growthPackage = await this.store.put({
      schema_id: "growth_package",
      // The `package` node (growth_packager) emits 1.2.0; package_release
      // re-emits the released 1.3.0 that every consumer reads.
      schema_version: "1.2.0",
      payload: episode.growth_package,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    const window = await buildPerformanceWindow(this.store);
    const performance = await this.store.put({
      schema_id: "performance_window",
      payload: window,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });

    let reusedVoiceId: string | undefined;
    if (opts.reuseVoiceArtifactId) {
      const voiceArtifact = await this.store.get(opts.reuseVoiceArtifactId);
      if (!voiceArtifact || voiceArtifact.schema_id !== "voice") {
        throw new Error(`reuseVoiceArtifactId ${opts.reuseVoiceArtifactId} is not a stored voice artifact`);
      }
      reusedVoiceId = opts.reuseVoiceArtifactId;
      console.log(`[run ${runId.slice(4, 12)}] reusing voice artifact ${reusedVoiceId.slice(0, 20)}… (operator-confirmed identical script)`);
    }

    const presetOutputs = {
      package: growthPackage.artifact.artifact_id,
      story: story.artifact.artifact_id,
      draft_script: script.artifact.artifact_id,
      ...(reusedVoiceId ? { voice: reusedVoiceId } : {}),
    };
    this.runs.set(runId, {
      runId,
      brief,
      createdAt: new Date().toISOString(),
      graph: `${this.graph.graph_id}@${this.graph.version}`,
      active: new Set(),
      completedOutputs: new Map(),
      presetOutputs: { ...presetOutputs },
      manualPresetOutputs: { ...presetOutputs },
      manualWatchabilityRescores: 0,
      last: null,
      finished: false,
      error: null,
    });

    void this.drive(runId, () =>
      this.executor.start(
        this.graph,
        { intent: intent.artifact.artifact_id, performance: performance.artifact.artifact_id },
        { runId, presetOutputs },
      ),
    ).then(() => this.driveUnattended(runId));
    return runId;
  }

  /** There is only one publish-capable production graph. */
  private resolveRunGraph(_ref: string | undefined): GraphDoc {
    return this.graph;
  }

  /**
   * Record the human editor's returned cut as `finalize_video`'s preset
   * output, so the next decide() on `editor_review` uses it instead of
   * letting finalize_video pass the draft through unchanged. Called by the
   * editor-watch poller once it finds and validates a `final.mp4` in the
   * run's Drive folder -- never by the editor directly, since Drive is the
   * only surface they touch.
   */
  async supplyEditorCut(
    runId: string,
    video: { bytes: Uint8Array; media_type: string; scene_count: number; degraded_scenes: number; duration_sec?: number },
    thumbnail?: { bytes: Uint8Array; media_type: string },
  ): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    const videoBlob = await this.blobs.put(video.bytes, { role: "video", media_type: video.media_type });
    // Carried on this artifact rather than by re-pinning the `thumbnail` node:
    // editor_package consumes that node, so replacing it would mark the
    // hand-off stale and re-park the run at editor_review. publish prefers
    // this one because the renderer below is "editor".
    const thumbnailBlob = thumbnail
      ? await this.blobs.put(thumbnail.bytes, { role: "thumbnail", media_type: thumbnail.media_type })
      : null;
    const draftId = state.completedOutputs.get("render");
    const draft = draftId ? await this.store.get(draftId) : null;
    // The editor may retain suggested stock. Preserve its attribution through
    // the replacement video artifact instead of dropping it on final.mp4 import.
    const credits = draft?.blobs?.filter(blob => blob.role === "footage_credits") ?? [];
    const artifact = await this.store.put({
      schema_id: "rendered_video",
      payload: {
        video_uri: videoBlob.uri,
        media_type: video.media_type,
        scene_count: video.scene_count,
        degraded_scenes: video.degraded_scenes,
        ...(video.duration_sec !== undefined ? { duration_sec: video.duration_sec } : {}),
        ...(thumbnailBlob ? { thumbnail_uri: thumbnailBlob.uri } : {}),
        renderer: "editor",
      },
      blobs: [videoBlob, ...(thumbnailBlob ? [thumbnailBlob] : []), ...credits],
      produced_by: { transformation: "finalize_video", version: "1", run_id: runId, provider: null },
    });
    state.presetOutputs = { ...(state.presetOutputs ?? {}), finalize_video: artifact.artifact.artifact_id };
  }

  /**
   * Poll every run parked at editor_review for a `final.mp4` dropped into its
   * Drive folder. A run that fails its check (bad geometry, transient Drive
   * error) is logged and left waiting for the next poll -- it must never
   * crash the run or the scheduler.
   */
  async checkEditorReturns(): Promise<{ checked: number; advanced: number }> {
    // The scheduler refuses to overlap its own jobs, but a webhook calling
    // this directly bypasses that guard entirely: two passes could download
    // the same final.mp4 and both approve the gate. Collapse concurrent
    // callers onto the one in-flight pass instead of racing.
    if (this.editorReturnsInFlight) return this.editorReturnsInFlight;
    const pass = this.runEditorReturnsPass().finally(() => {
      this.editorReturnsInFlight = null;
    });
    this.editorReturnsInFlight = pass;
    return pass;
  }

  private async runEditorReturnsPass(): Promise<{ checked: number; advanced: number }> {
    const drive = this.driveProvider;
    const runs = this.listRuns().filter((r) => r.waiting.some((w) => w.node_id === "editor_review"));
    if (!drive || runs.length === 0) return { checked: runs.length, advanced: 0 };

    let advanced = 0;
    for (const run of runs) {
      try {
        const handoffId = run.waiting.find((w) => w.node_id === "editor_review")!.artifact_id;
        const handoff = await this.store.get<{ drive_folder_id: string }>(handoffId);
        if (!handoff) continue;

        const files = await drive.listFiles(handoff.payload.drive_folder_id);
        const candidates = files.filter((f) => isEditorCutFilename(f.name));

        if (candidates.length === 0) {
          // Nothing to import. If the editor has put something of their own in
          // the folder, they believe they are done -- staying silent here is
          // how a misnamed upload waits forever with nobody told.
          const theirs = files.filter((f) => !isPipelineAuthoredFile(f.name));
          if (theirs.length > 0) await this.reportUnrecognisedEditorUpload(run, theirs.map((f) => f.name));
          continue;
        }
        if (candidates.length > 1) {
          // Two plausible cuts: publishing the wrong one is not recoverable,
          // and this codebase skips rather than guesses.
          await this.reportAmbiguousEditorCut(run, candidates.map((f) => f.name));
          continue;
        }
        const final = candidates[0]!;

        const state = await this.editorReturnState(run.run_id, final.id);
        if (state === "published") continue;
        if (state === "uncertain") {
          // Handed to publish, but no publish record exists. Either the upload
          // never happened or the process died in the window between YouTube
          // accepting it and the record being written -- and we cannot tell
          // which. Re-importing might put the episode on the channel twice,
          // which is not undoable, so this is the one case a human decides.
          await this.reportUncertainEditorCut(run, final.name);
          continue;
        }

        const bytes = await drive.downloadFile(final.id);

        // Drive lists a file the moment it is created, not when the upload
        // finishes, so a poll (or a creation-triggered webhook) can hand us a
        // truncated cut. Re-read the listing and require the size Drive now
        // reports to match what we actually downloaded; a mid-write file will
        // differ and simply waits for the next pass. Unsized files cannot be
        // verified, so they are skipped rather than trusted.
        const after = (await drive.listFiles(handoff.payload.drive_folder_id)).find((f) => f.id === final.id);
        if (after?.size === undefined) {
          console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: Drive reported no size for final.mp4; cannot confirm the upload finished, leaving it for the next pass`);
          continue;
        }
        if (after.size !== bytes.byteLength) {
          console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: final.mp4 still changing (${bytes.byteLength} -> ${after.size} bytes); waiting for the upload to settle`);
          continue;
        }

        assertYouTubeProductionGeometry(bytes);

        const renderId = run.nodes.find((n) => n.node_id === "render")?.artifact_id;
        const draft = renderId
          ? await this.store.get<{ scene_count?: number; degraded_scenes?: number; duration_sec?: number }>(renderId)
          : null;

        // Optional: the editor may also return a finished thumbnail. Two
        // candidates are as unresolvable here as two cuts, so neither is used.
        const thumbs = files.filter((f) => isEditorThumbnailFilename(f.name));
        let editorThumbnail: { bytes: Uint8Array; media_type: string } | undefined;
        if (thumbs.length === 1) {
          const picked = thumbs[0]!;
          const thumbBytes = await drive.downloadFile(picked.id);
          if (picked.size === thumbBytes.byteLength) {
            editorThumbnail = { bytes: thumbBytes, media_type: picked.mimeType || "image/png" };
          } else {
            console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: ${picked.name} still uploading; publishing with our own thumbnail`);
          }
        } else if (thumbs.length > 1) {
          console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: ${thumbs.length} candidate thumbnails; publishing with our own`);
        }

        await this.supplyEditorCut(run.run_id, {
          bytes,
          // Honour what the editor actually exported; .mov and .m4v are valid
          // YouTube uploads and mislabelling them as mp4 helps nobody.
          media_type: final.mimeType?.startsWith("video/") ? final.mimeType : "video/mp4",
          scene_count: draft?.payload.scene_count ?? 1,
          degraded_scenes: draft?.payload.degraded_scenes ?? 0,
          ...(draft?.payload.duration_sec !== undefined ? { duration_sec: draft.payload.duration_sec } : {}),
        }, editorThumbnail);
        // Written before the approval, not after: a crash between publishing
        // and recording must not look like a fresh cut on the next pass. The
        // cost is that a failure in decide() itself makes this run "uncertain"
        // and needs a human -- the safe side of an irreversible upload.
        await this.runLog.record({
          run_id: run.run_id,
          graph_id: `${this.graph.graph_id}@${this.graph.version}`,
          node_id: "editor_review",
          transformation: VidGenService.EDITOR_RETURN_MARKER,
          transformation_version: "1",
          inputs: [final.id],
          output: null,
          status: "ok",
          attempt: 1,
          max_attempts: 1,
          started_at: new Date().toISOString(),
          duration_ms: 0,
        });
        await this.decide(run.run_id, "editor_review", { result: "approve" });
        advanced += 1;
        console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: applied editor cut from Drive and resumed`);
      } catch (err) {
        // Same reasoning as the two report* helpers: the run is waiting rather
        // than failing, so without an alert a cut that throws every pass (bad
        // geometry, a Drive outage) retries unattended forever and nobody
        // learns. sendOperatorAlert dedups, so a persistent fault pings once
        // per cooldown rather than on every poll.
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[editor-watch] run ${run.run_id.slice(4, 12)} check failed: ${detail}`);
        await sendOperatorAlert({
          run_id: run.run_id,
          reason: "the editor's returned cut could not be imported",
          failures: [{ node_id: "editor_review", error: detail }],
        });
      }
    }
    return { checked: runs.length, advanced };
  }

  /**
   * Whether this exact returned file has already been handed to publish, read
   * from the durable run log rather than memory -- an in-memory set is empty
   * again after a deploy, and a run whose approval had not yet been persisted
   * still reads as `waiting`, so the same cut would be published twice.
   *
   * "published" is authoritative: a publish record exists, the episode is on
   * the channel, leave it alone. "uncertain" means it was handed over but no
   * publish record followed, which a human has to resolve.
   */
  private async editorReturnState(runId: string, fileId: string): Promise<"fresh" | "published" | "uncertain"> {
    const records = await this.runRecords(runId);
    const handedOver = records.some(
      (r) => r.transformation === VidGenService.EDITOR_RETURN_MARKER && r.inputs.includes(fileId),
    );
    if (!handedOver) return "fresh";
    return records.some((r) => r.node_id === "publish" && r.output) ? "published" : "uncertain";
  }

  private async reportUncertainEditorCut(run: RunView, name: string): Promise<void> {
    const detail = `${name} was already handed to publish but no publish was recorded; it may or may not be live. Check the channel, then either delete the file or resume the run manually -- it will not be imported again on its own.`;
    console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: ${detail}`);
    await sendOperatorAlert({
      run_id: run.run_id,
      reason: "a returned cut may already have been published",
      failures: [{ node_id: "editor_review", error: detail }],
    });
  }

  /**
   * The editor uploaded something, but nothing this run can import. Alerting
   * (rather than only logging) is the point: the run is waiting, not failing,
   * so no other signal would ever reach a human. sendOperatorAlert dedups on
   * run+reason, so a folder left in this state pings at most once per cooldown
   * instead of on every poll.
   */
  private async reportUnrecognisedEditorUpload(run: RunView, names: string[]): Promise<void> {
    const detail = `found ${names.map((n) => `"${n}"`).join(", ")}; expected a cut named final.mp4 (.mov/.m4v also accepted)`;
    console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: ${detail}`);
    await sendOperatorAlert({
      run_id: run.run_id,
      reason: "the editor uploaded a file this run cannot import",
      failures: [{ node_id: "editor_review", error: detail }],
    });
  }

  private async reportAmbiguousEditorCut(run: RunView, names: string[]): Promise<void> {
    const detail = `${names.length} possible cuts in the folder (${names.join(", ")}); leave exactly one so the right cut is published`;
    console.log(`[editor-watch] run ${run.run_id.slice(4, 12)}: ${detail}`);
    await sendOperatorAlert({
      run_id: run.run_id,
      reason: "more than one candidate cut in the editor folder",
      failures: [{ node_id: "editor_review", error: detail }],
    });
  }

  async decide(runId: string, nodeId: string, decision: GateDecision): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    const graph = this.resolveRunGraph(state.graph);
    void this.drive(runId, () => this.executor.resume(graph, runId, { [nodeId]: decision }, { presetOutputs: state.presetOutputs }));
  }

  /**
   * Retry a failed run from where it stopped — completed nodes are preserved.
   * This is the OPERATOR-FACING entry point (UI "Retry", API caller): it also
   * restarts unattended self-healing, in case the retry fails again and needs
   * another auto-repair round.
   *
   * driveUnattended()'s OWN retry loop must call resumeFailedRun() below
   * instead of this method. Chaining driveUnattended() from here again would
   * spawn a second, independent, unbounded driveUnattended() loop on every
   * single iteration of the first one — an exponential fan-out of concurrent
   * retries that never converges (each fresh loop's own round counter starts
   * back at 0, so its "give up after N attempts" ceiling never fires) and
   * corrupts persisted per-run counters like the script revision `attempt`
   * field by racing far more regenerations through than any one bounded loop
   * would ever allow. Real production incident: this looped thousands of
   * times in minutes and pushed a script's revision attempt past its schema
   * ceiling, permanently wedging the run.
   */
  async retry(runId: string): Promise<void> {
    void this.beginResumeFromFailure(runId).then(() => this.driveUnattended(runId));
  }

  /**
   * Resume a failed run from where it stopped, with no follow-on repair
   * chaining. driveUnattended()'s own retry loop calls THIS, not retry().
   */
  private async resumeFailedRun(runId: string): Promise<void> {
    await this.beginResumeFromFailure(runId);
  }

  /** Shared guard/state-reset/resume kickoff for retry() and resumeFailedRun(). */
  private beginResumeFromFailure(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    console.log(`[run ${runId.slice(4, 12)}] retrying from failure`);
    const graph = this.resolveRunGraph(state.graph);
    return this.drive(runId, () => this.executor.resume(graph, runId, {}, { presetOutputs: state.presetOutputs }));
  }

  /**
   * Operator-requested ONE-SHOT re-grade of a manual run that is blocked at
   * watchability_release. The critic is stochastic; a single fresh measurement
   * of the EXACT same immutable operator script is not a policy change (the
   * script, voice, thresholds and watchability-policy.ts are all untouched)
   * and is available exactly once per run. If the second independent read
   * also fails, the run stays blocked -- we do not keep sampling.
   *
   * Never reachable from unattended automation: it is a manual API action, and
   * driveUnattended() never calls it.
   */
  async rescoreManualWatchability(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    const view = this.getRun(runId);
    if (!view) throw new Error(`unknown run ${runId}`);
    if (!(await this.isManualScriptRun(view))) {
      throw new Error("watchability re-grade is only for operator-authored (manual) runs");
    }
    const blockedAtWatchability = (state.last?.failures ?? []).some((f) => f.node_id === "watchability_release");
    if (!blockedAtWatchability) {
      throw new Error("run is not currently blocked at watchability_release");
    }
    const used = state.manualWatchabilityRescores ?? 0;
    if (used >= MAX_MANUAL_WATCHABILITY_RESCORES) {
      throw new Error(`this run has already used its ${MAX_MANUAL_WATCHABILITY_RESCORES} operator watchability re-grade`);
    }
    state.manualWatchabilityRescores = used + 1;
    // Restore every operator preset (incl. the reused voice) so the cascade
    // below recomputes only the report and its dependents, not the immutable
    // upstream artifacts.
    state.presetOutputs = { ...(state.manualPresetOutputs ?? {}) };

    const graph = this.resolveRunGraph(state.graph);
    // Discard/recompute watchability_report only. The original artifact stays
    // in the store (content-addressed, immutable); a "retry" record on the
    // node is the auditable `operator_requested_rescore` marker, and
    // pruneIncompleteDependencies cascades staleness to watchability_release
    // and everything downstream.
    await this.executor.regenerateNode(graph, runId, "watchability_report", "operator_requested_rescore");
    state.finished = false;
    state.error = null;
    console.log(`[run ${runId.slice(4, 12)}] operator-requested one-shot watchability re-grade of the unchanged manual script`);
    void this.drive(runId, () =>
      this.executor.resume(graph, runId, {}, { presetOutputs: state.presetOutputs }),
    ).then(() => this.driveUnattended(runId));
  }

  /**
   * Adopt the canonical watchability decision from an EARLIER run whose script
   * and evaluator fingerprint are byte/config identical to this blocked manual
   * run. This is not another critic sample — it recognises that a watchability
   * decision is a derived artifact of immutable inputs and reuses the one that
   * was already adjudicated, exactly as a reused voice artifact is not
   * re-synthesised. It also seeds the ledger so future identical runs auto-reuse.
   */
  async adoptCanonicalWatchability(runId: string, fromRunId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    const view = this.getRun(runId);
    if (!view || !(await this.isManualScriptRun(view))) {
      throw new Error("adopting a watchability decision is only for operator-authored (manual) runs");
    }
    if (!(state.last?.failures ?? []).some((f) => f.node_id === "watchability_release")) {
      throw new Error("run is not currently blocked at watchability_release");
    }

    const targetScript = state.completedOutputs.get("draft_script") ?? state.manualPresetOutputs?.["draft_script"];
    const targetIntent = state.completedOutputs.get("intent");
    const targetFp = await this.watchabilityFingerprintInput(targetScript, targetIntent);
    if (!targetFp) throw new Error("cannot fingerprint this run's watchability inputs");

    const src = await this.runRecords(fromRunId);
    const ok = new Set(["ok", "cache_hit", "accepted_below_quality_bar"]);
    const srcLast = (nid: string) => src.filter((r) => r.node_id === nid && r.output && ok.has(r.status)).at(-1);
    const srcScript = srcLast("draft_script")?.output ?? undefined;
    const srcIntent = srcLast("intent")?.output ?? undefined;
    const srcReport = srcLast("watchability_report")?.output ?? undefined;
    const srcReleasePassed = src.some((r) => r.node_id === "watchability_release" && r.output && ok.has(r.status));
    if (!srcReport || !srcReleasePassed) {
      throw new Error(`source run ${fromRunId} has no watchability_report that cleared its release gate`);
    }
    if (srcScript !== targetScript) {
      throw new Error(`source script ${String(srcScript)} != this run's script ${String(targetScript)}; not byte-identical`);
    }
    const srcFp = await this.watchabilityFingerprintInput(srcScript, srcIntent);
    if (!srcFp || watchabilityFingerprint(srcFp) !== watchabilityFingerprint(targetFp)) {
      throw new Error("source and target watchability evaluator fingerprints differ (critic prompt/model/config or duration profile changed)");
    }

    await this.ledger.setCanonical(targetFp, srcReport, "adopted", `adopted from ${fromRunId}`);
    const graph = this.resolveRunGraph(state.graph);
    state.presetOutputs = { ...(state.manualPresetOutputs ?? {}) };
    await this.executor.pinNodeOutput(graph, runId, "watchability_report", srcReport, `adopted canonical watchability decision from ${fromRunId} (identical script + evaluator fingerprint)`);
    state.finished = false;
    state.error = null;
    console.log(`[run ${runId.slice(4, 12)}] adopted canonical watchability decision ${srcReport} from ${fromRunId}`);
    void this.drive(runId, () =>
      this.executor.resume(graph, runId, {}, { presetOutputs: state.presetOutputs }),
    ).then(() => this.driveUnattended(runId));
  }

  /**
   * Drive a run all the way to a terminal state without a human clicking
   * "Resume" -- for scheduled/unattended production, and also used by
   * startRun() generally so a manually-started episode gets the same
   * self-healing rather than parking with an avoidable defect.
   */
  private async driveUnattended(
    runId: string,
    // One less than MAX_ATTEMPTS_BEFORE_ACCEPTING: the final round pins the best
    // of the earlier drafts for a terminal evaluation rather than drafting again.
    maxRetries = MAX_ATTEMPTS_BEFORE_ACCEPTING - 1,
  ): Promise<void> {
    const scriptAttempts: Array<{ scriptId: string; reportId: string; avg: number }> = [];
    let moderationReviewAttempts = 0;
    for (let round = 0; ; round++) {
      for (let waitedMs = 0; !this.runs.get(runId)?.finished; waitedMs += 3000) {
        if (waitedMs >= 90 * 60_000) {
          console.log(`[run ${runId.slice(4, 12)}] unattended: still executing after 90min, giving up waiting`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const view = this.getRun(runId);
      if (!view) return;

      if (view.status === "waiting") {
        // editor_review is this pipeline's real finish line today: the editor
        // takes the Drive draft and publishes to YouTube entirely outside
        // this system. That is a successful, expected stop -- not a failure
        // needing an operator -- so it gets its own message instead of the
        // generic "needs an operator" one below (which is still correct for
        // every other human gate this run could be waiting on).
        if (view.waiting.some((w) => w.node_id === "editor_review")) {
          console.log(`[run ${runId.slice(4, 12)}] unattended: delivered to the editor -- pipeline work for this run is complete`);
          return;
        }
        console.log(`[run ${runId.slice(4, 12)}] unattended: parked on a human gate that did not auto-pass -- needs an operator`);
        return;
      }

      if (view.status !== "blocked" || (view.failures?.length ?? 0) === 0) return;

      // Structural package defects are not repaired by rerolling a script.
      if (view.failures.some((f) => isPackageContractFailureMessage(f.error))) {
        console.log(
          `[run ${runId.slice(4, 12)}] unattended: a structural package-contract defect cannot be repaired by ` +
            `regenerating the script -- needs operator attention: ${view.failures.map((f) => f.error).join("; ")}`,
        );
        return;
      }

      // A "review" verdict is borderline/false-positive-prone, not a confirmed
      // violation (see isModerationReviewFailureMessage) -- the same script
      // text fails identically forever otherwise, since resumeFailedRun()
      // alone re-checks nothing. This has its own MAX_MODERATION_REVIEW_ATTEMPTS
      // budget, checked before the shared watchability round cap below, so it
      // is never silently cut short by an unrelated counter.
      if (view.failures.some((f) => f.node_id === "voice" && isModerationReviewFailureMessage(f.error))) {
        // Manual mode still means the operator owns the words, exactly as
        // with watchability below.
        if (await this.isManualScriptRun(view)) {
          console.log(
            `[run ${runId.slice(4, 12)}] unattended: operator-authored script flagged by pre-TTS moderation review -- ` +
              `leaving it blocked for review instead of rewriting the operator's words`,
          );
          return;
        }

        moderationReviewAttempts++;
        if (moderationReviewAttempts > MAX_MODERATION_REVIEW_ATTEMPTS) {
          console.log(
            `[run ${runId.slice(4, 12)}] unattended: still blocked by pre-TTS moderation review after ` +
              `${MAX_MODERATION_REVIEW_ATTEMPTS} script rewrites, giving up -- needs operator attention: ` +
              `${view.failures.map((f) => f.error).join("; ")}`,
          );
          const giveUpState = this.runs.get(runId);
          const giveUpGraph = giveUpState ? this.resolveRunGraph(giveUpState.graph) : this.graph;
          for (const failure of view.failures) {
            await this.runLog.record({
              run_id: runId,
              graph_id: `${giveUpGraph.graph_id}@${giveUpGraph.version}`,
              node_id: failure.node_id,
              transformation: failure.node_id,
              transformation_version: this.transformations.get(failure.node_id)?.version ?? "1",
              inputs: [],
              output: null,
              status: "failed",
              attempt: 1,
              max_attempts: 1,
              started_at: new Date().toISOString(),
              duration_ms: 0,
              error: failure.error,
            });
          }
          return;
        }

        const state = this.runs.get(runId)!;
        const graph = this.resolveRunGraph(state.graph);
        await this.executor.regenerateNode(
          graph,
          runId,
          "draft_script",
          "voice blocked by pre-TTS moderation review -- regenerating the script with different wording",
        );
        console.log(
          `[run ${runId.slice(4, 12)}] unattended: voice blocked by moderation review -- regenerating script wording ` +
            `(attempt ${moderationReviewAttempts}/${MAX_MODERATION_REVIEW_ATTEMPTS})`,
        );
        await this.resumeFailedRun(runId);
        continue;
      }

      if (round >= maxRetries) {
        console.log(
          `[run ${runId.slice(4, 12)}] unattended: still blocked after ${maxRetries} auto-retries, giving up -- ` +
            `needs operator attention: ${view.failures.map((f) => f.error).join("; ")}`,
        );
        // Only the FIRST watchability_release failure of a driveUnattended
        // cycle ever gets a persisted run-log record -- every later round's
        // failure lives only in this process's in-memory RunState. Without
        // this, a restart's reloadRuns() reconstructs "attempt 1" forever,
        // so watchabilityRetryState() reports "retrying" for an already-
        // exhausted run and a scheduler recovery pass retries it forever
        // instead of recognizing the terminal creative failure. Persist the
        // real final state so it survives a restart.
        const state = this.runs.get(runId);
        const graph = state ? this.resolveRunGraph(state.graph) : this.graph;
        for (const failure of view.failures) {
          await this.runLog.record({
            run_id: runId,
            graph_id: `${graph.graph_id}@${graph.version}`,
            node_id: failure.node_id,
            transformation: failure.node_id,
            transformation_version: this.transformations.get(failure.node_id)?.version ?? "1",
            inputs: [],
            output: null,
            status: "failed",
            attempt: 1,
            max_attempts: 1,
            started_at: new Date().toISOString(),
            duration_ms: 0,
            error: failure.error,
          });
        }
        return;
      }

      if (view.failures.some((f) => f.node_id === "watchability_release")) {
        // Manual mode means the operator owns the words. We still evaluate
        // watchability, but never silently rewrite their script to clear a bar.
        if (await this.isManualScriptRun(view)) {
          console.log(
            `[run ${runId.slice(4, 12)}] unattended: operator-authored script failed watchability -- ` +
              `leaving it blocked for review instead of rewriting the operator's words`,
          );
          return;
        }

        const rejected = await this.currentScriptAttempt(view);
        if (rejected && !scriptAttempts.some((a) => a.reportId === rejected.reportId)) scriptAttempts.push(rejected);
        const state = this.runs.get(runId)!;
        const graph = this.resolveRunGraph(state.graph);

        const nextAttemptAccepts = scriptAttempts.length >= MAX_ATTEMPTS_BEFORE_ACCEPTING - 1;
        if (nextAttemptAccepts && scriptAttempts.length > 1) {
          const best = scriptAttempts.reduce((a, b) => (b.avg > a.avg ? b : a));
          const reason = `best of ${scriptAttempts.length} watchability attempts (avg ${best.avg.toFixed(3)}) -- picked before the accepting attempt, not after image generation`;
          await this.executor.pinNodeOutput(graph, runId, "draft_script", best.scriptId, reason);
          await this.executor.pinNodeOutput(graph, runId, "watchability_report", best.reportId, reason);
          console.log(
            `[run ${runId.slice(4, 12)}] unattended: watchability blocked -- restoring the best of ${scriptAttempts.length} ` +
              `attempts (avg ${best.avg.toFixed(3)}) for the final evaluation instead of drafting another (retry ${round + 1}/${maxRetries})`,
          );
        } else {
          await this.executor.regenerateNode(graph, runId, "draft_script", "watchability release blocked -- regenerating the script, not just re-checking it");
          console.log(`[run ${runId.slice(4, 12)}] unattended: watchability blocked -- regenerating the script itself (retry ${round + 1}/${maxRetries})`);
        }
      } else {
        console.log(`[run ${runId.slice(4, 12)}] unattended: auto-resuming a blocked attempt (retry ${round + 1}/${maxRetries})`);
      }
      await this.resumeFailedRun(runId);
    }
  }

  /** Whether the current draft_script artifact was authored deterministically by the operator. */
  private async isManualScriptRun(view: RunView): Promise<boolean> {
    const scriptId = view.nodes.find((n) => n.node_id === "draft_script")?.artifact_id;
    if (!scriptId) return false;
    const script = await this.store.get(scriptId);
    return script?.produced_by?.transformation === "human";
  }

  /**
   * Poll until a run reaches a terminal status (completed/blocked/waiting),
   * without retrying anything itself -- for a caller (the scheduler) that
   * needs to know when a run genuinely finished, while startRun()'s own
   * driveUnattended() chain does the actual retrying. Same 90-minute ceiling
   * as driveUnattended()'s own wait loop.
   */
  private async waitForTerminal(runId: string): Promise<void> {
    let stableTicks = 0;
    for (let waitedMs = 0; ; waitedMs += 3000) {
      const view = this.getRun(runId);
      if (!view) return;
      if (view.status === "running") {
        stableTicks = 0;
      } else {
        stableTicks++;
        if (stableTicks >= 2) return;
      }
      if (waitedMs >= 90 * 60_000) {
        console.log(`[run ${runId.slice(4, 12)}] still running after 90min, giving up waiting`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  /** This run's current draft_script/watchability_report pair and the average score they were evaluated at, if both exist yet. */
  private async currentScriptAttempt(view: RunView): Promise<{ scriptId: string; reportId: string; avg: number } | null> {
    const scriptId = view.nodes.find((n) => n.node_id === "draft_script")?.artifact_id;
    const reportId = view.nodes.find((n) => n.node_id === "watchability_report")?.artifact_id;
    if (!scriptId || !reportId) return null;
    const report = await this.store.get(reportId);
    if (!report) return null;
    const { average } = assessWatchability(report.payload);
    return { scriptId, reportId, avg: average };
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

  private static kindOf(graph: string): RunKind {
    if (graph.startsWith("illustrated_story")) return "production";
    if (graph.startsWith("measure")) return "measure";
    if (graph.startsWith("discover")) return "discover";
    return "other";
  }

  private view(s: RunState): RunView {
    const outputs = s.last?.outputs ?? {};
    const waitingBy = new Map((s.last?.waiting ?? []).map((w) => [w.node_id, w]));
    const failureBy = new Map((s.last?.failures ?? []).map((f) => [f.node_id, f]));
    const blocked = new Set(s.last?.blocked ?? []);

    const runGraph = s.graph ?? `${this.graph.graph_id}@${this.graph.version}`;
    const matchedGraph = `${this.graph.graph_id}@${this.graph.version}` === runGraph ? this.graph : null;

    const nodes: NodeView[] = !matchedGraph ? [] : matchedGraph.nodes.map((n) => {
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

    const graph = s.last?.graph ?? runGraph;
    return {
      run_id: s.runId,
      graph,
      kind: VidGenService.kindOf(graph),
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

  /** Close out a non-production run row. */
  private async closeRun(runId: string, status: string, error?: string | null): Promise<void> {
    if (!(this.runLog instanceof PgRunLog)) return;
    await this.runLog.updateRunStatus(runId, status, error ?? null);
    const cost = rollup(await this.runLog.forRun(runId)).cost_usd;
    await this.runLog.updateRunCost(runId, cost);
  }

  /** Measure every published episode. */
  async measureAll(): Promise<{
    measured: Array<{ external_id: string; views: number }>;
    skipped: Array<{ external_id: string; visibility: string }>;
    failed: Array<{ external_id: string; error: string }>;
  }> {
    const rows = (await this.store.index()).filter(
      (r) => r.schema_id === "published_episode",
    );

    const measured: Array<{ external_id: string; views: number }> = [];
    const skipped: Array<{ external_id: string; visibility: string }> = [];
    const failed: Array<{ external_id: string; error: string }> = [];
    const seen = new Set<string>();

    const candidates: Array<{ artifactId: string; externalId: string }> = [];
    for (const row of rows) {
      const episode = await this.store.get(row.artifact_id);
      if (!episode) continue;
      const externalId = (episode.payload as { external_id?: string }).external_id;
      if (!externalId || seen.has(externalId)) continue;
      seen.add(externalId);
      candidates.push({ artifactId: row.artifact_id, externalId });
    }

    const analytics = this.analyticsProvider;
    if (!analytics) {
      return { measured, skipped, failed: candidates.map(c => ({ external_id: c.externalId, error: "Analytics provider is not configured; configure YouTube Analytics authorization before measuring." })) };
    }
    let visibility: Record<string, string> = {};
    if (analytics && candidates.length > 0) {
      try {
        visibility = await analytics.fetchVisibility(candidates.map((c) => c.externalId));
      } catch (error) {
        const message = `analytics visibility preflight failed: ${String(error)}`;
        return { measured, skipped, failed: candidates.map(c => ({ external_id: c.externalId, error: message })) };
      }
    }

    const excluded = excludedIds();

    for (const { artifactId: rowId, externalId } of candidates) {
      if (excluded.has(externalId)) {
        skipped.push({ external_id: externalId, visibility: "excluded" });
        continue;
      }
      const vis = visibility[externalId] ?? "unknown";
      if (vis !== "public") {
        skipped.push({ external_id: externalId, visibility: vis });
        continue;
      }
      const row = { artifact_id: rowId };

      const runId = `run_${randomUUID()}`;
      try {
        if (this.runLog instanceof PgRunLog) {
          await this.runLog.createRun(
            runId,
            `measure ${externalId}`,
            `${this.measureGraph.graph_id}@${this.measureGraph.version}`,
          );
        }

        const result = await this.executor.start(
          this.measureGraph,
          { episode: row.artifact_id },
          { runId },
        );
        const outId = result.outputs["performance"];
        if (result.status !== "completed" || !outId) {
          throw new Error(`measurement ${result.status}: ${(result.failures ?? []).map(f => f.error).join("; ") || "no completed performance output"}; inspect run ${runId}`);
        }
        const perf = outId ? await this.store.get(outId) : null;
        if (!perf) throw new Error(`measurement artifact missing for run ${runId}`);
        const views = (perf?.payload as { metrics?: { views?: number } })?.metrics?.views ?? 0;
        await this.closeRun(runId, result.status);
        measured.push({ external_id: externalId, views });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.closeRun(runId, "failed", message).catch(() => {});
        failed.push({ external_id: externalId, error: message });
      }
    }

    return { measured, skipped, failed };
  }

  /** Propose topics for the next episode. */
  async discoverTopics(): Promise<{
    candidates: unknown;
    history_count: number;
    measured_episodes: number;
  }> {
    const exclude = excludedIds();
    const history = await buildTopicHistory(this.store, { exclude });
    const window = await buildPerformanceWindow(this.store, { exclude });

    const runId = `run_${randomUUID()}`;
    if (this.runLog instanceof PgRunLog) {
      await this.runLog.createRun(
        runId,
        "discover topics",
        `${this.discoverGraph.graph_id}@${this.discoverGraph.version}`,
      );
    }

    const historyArt = await this.store.put({
      schema_id: "topic_history",
      payload: history,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });
    const perfArt = await this.store.put({
      schema_id: "performance_window",
      payload: window,
      produced_by: { transformation: "human", version: "1", run_id: runId, provider: null },
    });

    const result = await this.executor.start(
      this.discoverGraph,
      {
        history: historyArt.artifact.artifact_id,
        performance: perfArt.artifact.artifact_id,
      },
      { runId },
    );

    const outId = result.outputs["candidates"];
    const artifact = outId ? await this.store.get(outId) : null;
    await this.closeRun(runId, result.status);

    return {
      candidates: artifact?.payload ?? null,
      history_count: history.count,
      measured_episodes: window.episode_count,
    };
  }

  /** Wire up recurring jobs. */
  startScheduler(opts: { tickMs?: number } = {}): Scheduler {
    const num = (key: string): number | null => {
      const raw = process.env[key]?.trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const hour = (key: string, fallback: number): number => {
      const raw = process.env[key]?.trim();
      if (!raw) return fallback;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
    };
    /**
     * SCHEDULE_PRODUCE_HOUR_UTC, when set, is a literal UTC hour override --
     * useful for a channel that genuinely wants "whatever hour that is
     * everywhere", or for a one-off manual pin. Otherwise resolve today's UTC
     * hour from a local wall-clock target (default 9pm Europe/Berlin), so the
     * schedule survives a DST change without silently drifting an hour --
     * this recomputes fresh every service start, and the project redeploys
     * on every merge to main, so restart-driven staleness isn't a real risk.
     */
    const produceHourUtc = (): number => {
      const explicit = process.env["SCHEDULE_PRODUCE_HOUR_UTC"]?.trim();
      if (explicit) return hour("SCHEDULE_PRODUCE_HOUR_UTC", 19);
      const timeZone = process.env["SCHEDULE_PRODUCE_TIMEZONE"]?.trim() || "Europe/Berlin";
      const localHour = hour("SCHEDULE_PRODUCE_LOCAL_HOUR", 21);
      try {
        return localHourToUtcHour(timeZone, localHour);
      } catch {
        console.warn(`[scheduler] SCHEDULE_PRODUCE_TIMEZONE "${timeZone}" is not a recognized IANA zone; falling back to 19:00 UTC`);
        return 19;
      }
    };
    const produceTargetHourUtc = produceHourUtc();

    const lastProduceAt = Math.max(
      -Infinity,
      ...this.listRuns()
        .filter((r) => r.kind === "production")
        .map((r) => Date.parse(r.created_at))
        .filter((t) => Number.isFinite(t)),
    );

    const jobs: Job[] = [
      {
        id: "measure",
        description: "Measure published episodes and feed the strategist",
        everyHours: num("SCHEDULE_MEASURE_HOURS") ?? 24,
        enabled:
          process.env["SCHEDULE_MEASURE_HOURS"]?.trim() !== "0" &&
          Boolean(this.analyticsProvider),
        run: async () => {
          const r = await this.measureAll();
          console.log(
            `[scheduler] measured ${r.measured.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`,
          );
          if (r.failed.length) throw new Error(`Measurement failed for ${r.failed.length} episode(s): ${r.failed[0]!.error}`);
        },
      },
      {
        id: "produce",
        description: `Pick the top discovery candidate, produce it and publish it — one episode a day, targeting 9pm ${process.env["SCHEDULE_PRODUCE_TIMEZONE"]?.trim() || "Europe/Berlin"} (currently ${produceTargetHourUtc}:00 UTC)`,
        everyHours: num("SCHEDULE_PRODUCE_HOURS") ?? 24,
        targetHourUtc: produceTargetHourUtc,
        ...(Number.isFinite(lastProduceAt) ? { seedLastRun: lastProduceAt } : {}),
        enabled: process.env["SCHEDULE_PRODUCE_HOURS"]?.trim() !== "0",
        run: async () => {
          const found = await this.discoverTopics();
          const top = (found.candidates as { candidates?: DiscoveryCandidate[] } | null)?.candidates?.[0];
          if (!top?.brief) {
            console.log("[scheduler] discovery returned no candidate; not starting a run");
            return;
          }
          const seed = packageSeedOf(top);
          if (!seed) {
            console.log("[scheduler] winning candidate is missing package fields; running it as a plain brief");
          }
          const runId = await this.startRun(top.brief, undefined, {
            niche: "practical-social-intelligence",
            ...(top.genre ? { genre: top.genre } : {}),
            ...(seed ? { packageSeed: seed } : {}),
          });
          console.log(`[scheduler] started ${runId} for: ${top.brief} -- driving unattended through to publish`);
          await this.waitForTerminal(runId);
          const finalStatus = this.getRun(runId)?.status;
          console.log(`[scheduler] ${runId} finished: ${finalStatus}`);
        },
      },
    ];

    this.scheduler = new Scheduler({
      jobs,
      ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
    });
    this.scheduler.start();
    return this.scheduler;
  }

  scheduleStatus(): JobStatus[] {
    return this.scheduler?.status() ?? [];
  }

  async runJobNow(id: string): Promise<void> {
    if (!this.scheduler) throw new Error("the scheduler is not running");
    await this.scheduler.runNow(id);
  }

  stopScheduler(): void {
    this.scheduler?.stop();
  }

  get graphDoc(): GraphDoc {
    return this.graph;
  }
}
