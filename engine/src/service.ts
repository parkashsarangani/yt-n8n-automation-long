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
  type AnalyticsProvider,
  type ImageProvider,
  type MediaRenderer,
  type PublishTarget,
  type SpeechProvider,
} from "./provider.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { ElevenLabsProvider } from "./providers/elevenlabs.ts";
import { StockImageProvider } from "./providers/stock.ts";
import { FreeMediaImageProvider } from "./providers/free-media-image.ts";
import { policyFlag } from "./fallback-policy.ts";
import { ComposeRenderer } from "./providers/compose.ts";
import { YouTubeTarget } from "./providers/youtube.ts";
import { YouTubeAnalyticsProvider } from "./providers/youtube-analytics.ts";
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
import { loadGraph, nodeType, inputsOf, type GraphDoc } from "./graph.ts";
import { buildPerformanceWindow, excludedIds } from "./performance-window.ts";
import { buildTopicHistory } from "./topic-history.ts";
import { buildManualEpisode, type ManualScriptInput } from "./manual-script.ts";
import { Scheduler, type Job, type JobStatus } from "./scheduler.ts";
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

export interface ServiceOptions {
  root: string;
  dataDir?: string;
  envFile?: string;
  /** Publishing for real requires an explicit opt-in, never just a token. */
  allowPublish?: boolean;
}

type Genre = "moral_story" | "drama" | "true_story" | "short_story";
type ImageStyle = "ink_wash_stickman" | "flat_comic_expressive" | "documentary_sketch" | "watercolor_storybook" | "noir_charcoal";

/** The two operator-selectable knobs from intent@1.2.0 (schemas/intent). */
export interface RunOptions {
  genre?: Genre;
  imageStyle?: ImageStyle;
  /**
   * The discovery-tournament winner, passed as typed data on intent rather
   * than smuggled into the brief text. RFC 0009 decision 1 requires production
   * to BEGIN from the already-selected package; a prose brief the packager has
   * to parse is a contract it can silently ignore -- and did, because the
   * marker the scheduler wrote never matched the one the prompt read.
   */
  packageSeed?: PackageSeed;
}

/**
 * When the operator leaves image_style on "Auto" (no explicit pick), the
 * style still shouldn't be genre-blind -- flat_comic_expressive reads wrong
 * on a moral_story, ink_wash_stickman under-serves a true_story's need for
 * a specific human likeness. This is only a default: an explicit opts.imageStyle
 * always wins (see startRun below), so the operator can still override per
 * episode. noir_charcoal has no genre default -- it's suspense/thriller
 * content within a genre, not a genre of its own, so it stays a manual pick.
 */
const GENRE_DEFAULT_STYLE: Record<Genre, ImageStyle> = {
  moral_story: "ink_wash_stickman",
  drama: "flat_comic_expressive",
  true_story: "documentary_sketch",
  short_story: "watercolor_storybook",
};

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
  /** Held so measureAll can check live visibility before spending a call. */
  private analyticsProvider: AnalyticsProvider | undefined;

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
    // Defense in depth (mirrors capabilities.imagesStageSatisfied):
    //   fal key + PAID_IMAGE_FALLBACK on  -> fal-backed provider; the resolver
    //                                        still tries the free chain first.
    //   otherwise (incl. fal key present but paid OFF) -> free-only provider,
    //                                        so fal is never even constructed.
    //   stage not satisfied at all -> fake.
    const paidImageOn = policyFlag(process.env["PAID_IMAGE_FALLBACK"], true);
    const images: ImageProvider = !can("images")
      ? new FakeImageProvider()
      : env("FAL_KEY") && paidImageOn
        ? new StockImageProvider({
          ...(env("FAL_MODEL") ? { model: env("FAL_MODEL") } : {}),
          ...(env("FAL_EDIT_MODEL") ? { editModel: env("FAL_EDIT_MODEL") } : {}),
          ...(env("FAL_PRICE_PER_IMAGE") ? { pricePerImage: Number(env("FAL_PRICE_PER_IMAGE")) } : {}),
        })
        : new FreeMediaImageProvider();
    const renderer: MediaRenderer = can("renderer")
      ? new ComposeRenderer({ baseUrl: env("COMPOSE_URL")! })
      : new FakeRenderer();

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
      }),
    );
    validateGraph(this.graph, { registry: this.registry, transformations: this.transformations });

    // Both reasoning tiers resolve to OpenAIProvider, which is free-first:
    // requests walk the ordered free FreeLLMAPI chain and only fall through to
    // paid OpenAI (gpt-5.6-luna) when the free chain is exhausted OR the agent
    // sets model.prefer_paid_reasoning (a spend-authorizing judge/reviser whose
    // quality bar is calibrated to the paid model). It's a capability, not a
    // vendor/model (RFC 0004).
    const providers = new ProviderRouter({
      reasoning_high: new OpenAIProvider({ effort: "medium" }),
      reasoning_fast: new OpenAIProvider({ effort: "medium" }),
    });

    const runner = new Runner({
      store: this.store,
      registry: this.registry,
      prompts: this.prompts,
      providers,
      runLog: this.runLog,
      blobs: this.blobs,
      media: { speech, images, renderer, ...(analytics ? { analytics } : {}) },
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
    const trimmed = brief.trim();
    if (trimmed.length < 8) throw new Error("brief is too short");
    if (!process.env["OPENAI_API_KEY"]?.trim()) {
      throw new Error("OPENAI_API_KEY is not set — the reasoning agents cannot run");
    }

    const runId = `run_${randomUUID()}`;
    // Explicit operator pick always wins; otherwise derive a genre-appropriate
    // default rather than always falling back to ink_wash_stickman.
    const resolvedImageStyle = opts.imageStyle ?? (opts.genre ? GENRE_DEFAULT_STYLE[opts.genre] : undefined);
    console.log(`[run ${runId.slice(4, 12)}] starting: "${trimmed}" (${durationSec}s)${opts.genre ? `, genre=${opts.genre}` : ""}${resolvedImageStyle ? `, image_style=${resolvedImageStyle}${opts.imageStyle ? "" : " (auto)"}` : ""}`);

    // Persist run in Postgres if available
    if (this.runLog instanceof PgRunLog) {
      await this.runLog.createRun(runId, trimmed, `${this.graph.graph_id}@${this.graph.version}`);
    }

    const intent = await this.store.put({
      schema_id: "intent",
      payload: {
        brief: trimmed,
        target_duration_sec: durationSec,
        ...(opts.genre ? { genre: opts.genre } : {}),
        ...(resolvedImageStyle ? { image_style: resolvedImageStyle } : {}),
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
   * — strategy/package, watchability evaluation, moderation, TTS, RFC 0010
   * visuals, SEO/thumbnail, render, QA and publish — is the same production DAG.
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
    const resolvedImageStyle = opts.imageStyle ?? (opts.genre ? GENRE_DEFAULT_STYLE[opts.genre] : undefined);
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
        ...(resolvedImageStyle ? { image_style: resolvedImageStyle } : {}),
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

  async decide(runId: string, nodeId: string, decision: GateDecision): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    const graph = this.resolveRunGraph(state.graph);
    void this.drive(runId, () => this.executor.resume(graph, runId, { [nodeId]: decision }, { presetOutputs: state.presetOutputs }));
  }

  /** Retry a failed run from where it stopped — completed nodes are preserved. */
  async retry(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    console.log(`[run ${runId.slice(4, 12)}] retrying from failure`);
    const graph = this.resolveRunGraph(state.graph);
    void this.drive(runId, () => this.executor.resume(graph, runId, {}, { presetOutputs: state.presetOutputs }));
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
    maxAssetRegens = 2,
    maxVisualReleaseRegens = 3,
  ): Promise<void> {
    let assetRegens = 0;
    let visualReleaseRegens = 0;
    const scriptAttempts: Array<{ scriptId: string; reportId: string; avg: number }> = [];
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
        const parkedAtPublish = view.waiting.some((w) => w.node_id === "approve_publish");
        const blankScenes = parkedAtPublish && assetRegens < maxAssetRegens ? await this.qaBlankSceneCount(view) : 0;
        if (blankScenes > 0) {
          assetRegens++;
          console.log(
            `[run ${runId.slice(4, 12)}] unattended: qa reported ${blankScenes} blank scene(s) -- ` +
              `regenerating resolved visual beats and re-rendering (attempt ${assetRegens}/${maxAssetRegens})`,
          );
          const state = this.runs.get(runId)!;
          const graph = this.resolveRunGraph(state.graph);
          await this.executor.regenerateNode(graph, runId, "visual_assets", `qa reported ${blankScenes} blank/placeholder scene(s)`);
          await this.retry(runId);
          continue;
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

      // The RFC 0010 production visual release is deterministic over current
      // resolved assets/timeline. Regenerate the resolver node, not the
      // compatibility manifest, so retries actually obtain new media while
      // keeping already-valid resolver reuse/cache semantics.
      if (view.failures.some((f) => f.node_id === "visual_asset_release")) {
        const reason = view.failures.find((f) => f.node_id === "visual_asset_release")!.error;
        if (visualReleaseRegens < maxVisualReleaseRegens) {
          visualReleaseRegens++;
          console.log(
            `[run ${runId.slice(4, 12)}] unattended: visual_asset_release blocked -- regenerating resolved visual beats ` +
              `(attempt ${visualReleaseRegens}/${maxVisualReleaseRegens}): ${reason}`,
          );
          const state = this.runs.get(runId)!;
          const graph = this.resolveRunGraph(state.graph);
          await this.executor.regenerateNode(graph, runId, "visual_assets", `visual_asset_release blocked: ${reason}`);
          await this.retry(runId);
          continue;
        }
        console.log(
          `[run ${runId.slice(4, 12)}] unattended: visual_asset_release still blocked after ${maxVisualReleaseRegens} ` +
            `targeted regenerations -- needs operator attention: ${view.failures.map((f) => f.error).join("; ")}`,
        );
        return;
      }

      if (round >= maxRetries) {
        console.log(
          `[run ${runId.slice(4, 12)}] unattended: still blocked after ${maxRetries} auto-retries, giving up -- ` +
            `needs operator attention: ${view.failures.map((f) => f.error).join("; ")}`,
        );
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
      await this.retry(runId);
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

  /** How many scenes in this run's qa_report came back as a true blank placeholder, not just a repeated fallback shot. */
  private async qaBlankSceneCount(view: RunView): Promise<number> {
    const qaArtifactId = view.nodes.find((n) => n.node_id === "qa")?.artifact_id;
    if (!qaArtifactId) return 0;
    const qa = await this.store.get<{ checks?: Array<{ id: string; status: string; measured?: number | null }> }>(qaArtifactId);
    const check = qa?.payload.checks?.find((c) => c.id === "blank_scenes");
    return check?.status === "fail" && typeof check.measured === "number" ? check.measured : 0;
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
    let visibility: Record<string, string> = {};
    if (analytics && candidates.length > 0) {
      try {
        visibility = await analytics.fetchVisibility(candidates.map((c) => c.externalId));
      } catch {
        visibility = {};
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
        const perf = outId ? await this.store.get(outId) : null;
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
        },
      },
      {
        id: "produce",
        description: `Pick the top discovery candidate, produce it and publish it — one episode a day, timed for a US audience (~${hour("SCHEDULE_PRODUCE_HOUR_UTC", 19)}:00 UTC)`,
        everyHours: num("SCHEDULE_PRODUCE_HOURS") ?? 24,
        targetHourUtc: hour("SCHEDULE_PRODUCE_HOUR_UTC", 19),
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
