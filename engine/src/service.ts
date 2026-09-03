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

type Genre = "moral_story" | "drama" | "true_story" | "short_story";
type ImageStyle = "ink_wash_stickman" | "flat_comic_expressive" | "documentary_sketch" | "watercolor_storybook" | "noir_charcoal";

/** The two operator-selectable knobs from intent@1.2.0 (schemas/intent). */
export interface RunOptions {
  genre?: Genre;
  imageStyle?: ImageStyle;
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
  private manualGraph!: GraphDoc;
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
    // The default AI-driven graph (RFC 0008): single-narrator voice-over over
    // illustrated stills. Replaced the two-host character/dialogue pipeline
    // ("skeleton.json") outright — see docs/0008-illustrated-story-format.md.
    svc.graph = await loadGraph(path.join(opts.root, "graphs", "illustrated_story.json"));
    svc.measureGraph = await loadGraph(path.join(opts.root, "graphs", "measure.json"));
    svc.discoverGraph = await loadGraph(path.join(opts.root, "graphs", "discover.json"));
    svc.manualGraph = await loadGraph(path.join(opts.root, "graphs", "manual.json"));
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
      ? new StockImageProvider({
        ...(env("FAL_MODEL") ? { model: env("FAL_MODEL") } : {}),
        ...(env("FAL_EDIT_MODEL") ? { editModel: env("FAL_EDIT_MODEL") } : {}),
        ...(env("FAL_PRICE_PER_IMAGE") ? { pricePerImage: Number(env("FAL_PRICE_PER_IMAGE")) } : {}),
      })
      : new FakeImageProvider();
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
        // Public by operator decision: every episode that reaches publish has
        // already passed the qa/approve_publish stages, so there is no
        // separate manual "make it public" step left to do.
        publish: { target, privacy: "public" },
      }),
    );
    validateGraph(this.graph, { registry: this.registry, transformations: this.transformations });
    validateGraph(this.manualGraph, { registry: this.registry, transformations: this.transformations });

    // reasoning_high runs on gpt-5.6-luna, not a bigger tier - a deliberate,
    // revisitable cost decision (Luna: $0.20/$1.20 per M tokens vs. Terra's
    // $2/$12). It's a capability, not a vendor/model (RFC 0004), so no
    // agent config had to change to make this switch.
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
      // different one: measure@1 and older skeleton versions have different
      // node sets, so every one of them looked permanently "waiting". The runs
      // table already knows how each finished, so trust that and only fall back
      // to counting nodes when there is no stored status.
      const runGraph = stored?.graph ?? `${this.graph.graph_id}@${this.graph.version}`;
      const matchedGraph = [this.graph, this.manualGraph].find(
        (g) => `${g.graph_id}@${g.version}` === runGraph,
      );
      const allDone = !!matchedGraph && completedOutputs.size === matchedGraph.nodes.length;
      const derived = allDone ? "completed" : hasFailure ? "blocked" : "waiting";
      // A row still marked "running" at reload time is stale by definition:
      // this is a fresh process, so whatever owned that run is gone. Reporting
      // it as running would show phantom work in flight forever — which is
      // exactly how the two orphaned measure runs looked.
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
    void this.drive(runId, () =>
      this.executor.start(this.graph, { intent: intent.artifact.artifact_id, performance: performance.artifact.artifact_id }, { runId }),
    );
    return runId;
  }

  /**
   * Start a run from an operator-written hook and narration. story_architect
   * and script_writer never run — manual-script.ts builds their artifacts
   * mechanically — but every stage after that (visuals, voice, SEO, thumbnail,
   * render, QA, publish) runs exactly as it does for an AI-drafted episode.
   */
  async startManualRun(input: ManualScriptInput, durationSec = 540): Promise<string> {
    const episode = buildManualEpisode(input); // throws with a clear message on bad input

    const runId = `run_${randomUUID()}`;
    const brief = episode.story.title;
    console.log(`[run ${runId.slice(4, 12)}] starting (manual script): "${brief}" (${durationSec}s)`);

    if (this.runLog instanceof PgRunLog) {
      await this.runLog.createRun(runId, brief, `${this.manualGraph.graph_id}@${this.manualGraph.version}`);
    }

    const intent = await this.store.put({
      schema_id: "intent",
      payload: { brief, target_duration_sec: durationSec },
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

    this.runs.set(runId, {
      runId,
      brief,
      createdAt: new Date().toISOString(),
      graph: `${this.manualGraph.graph_id}@${this.manualGraph.version}`,
      active: new Set(),
      completedOutputs: new Map(),
      last: null,
      finished: false,
      error: null,
    });

    void this.drive(runId, () =>
      this.executor.start(
        this.manualGraph,
        {
          intent: intent.artifact.artifact_id,
          story: story.artifact.artifact_id,
          script: script.artifact.artifact_id,
        },
        { runId },
      ),
    );
    return runId;
  }

  /** Resolves which loaded graph a run used, falling back to the AI-driven one. */
  private resolveRunGraph(ref: string | undefined): GraphDoc {
    return (
      [this.graph, this.manualGraph].find(
        (g) => `${g.graph_id}@${g.version}` === ref,
      ) ?? this.graph
    );
  }

  async decide(runId: string, nodeId: string, decision: GateDecision): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown run ${runId}`);
    if (!state.finished) throw new Error(`run ${runId} is still executing`);
    state.finished = false;
    state.error = null;
    const graph = this.resolveRunGraph(state.graph);
    void this.drive(runId, () => this.executor.resume(graph, runId, { [nodeId]: decision }));
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
    void this.drive(runId, () => this.executor.resume(graph, runId, {}));
  }

  /**
   * Drive a run all the way to a terminal state without a human clicking
   * "Resume" -- for scheduled/unattended production only. A worker failure
   * (e.g. watchability_release's own MAX_ATTEMPTS_BEFORE_ACCEPTING escape
   * hatch) intentionally parks a run "blocked" rather than looping itself,
   * so a manually-started run's operator can inspect before retrying (see
   * retry() above and the Studio UI's "Resume blocked run" banner) -- but
   * a scheduled run has no one watching, so without this it would just sit
   * blocked forever and the day's episode would never actually publish.
   * Bounded so a genuinely broken run (bad credentials, a real bug) cannot
   * spin forever; the next scheduled tick tries a fresh episode regardless.
   */
  private async driveUnattended(runId: string, maxRetries = 5): Promise<void> {
    for (let round = 0; ; round++) {
      for (let waitedMs = 0; !this.runs.get(runId)?.finished; waitedMs += 3000) {
        if (waitedMs >= 30 * 60_000) {
          console.log(`[run ${runId.slice(4, 12)}] unattended: still executing after 30min, giving up waiting`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const view = this.getRun(runId);
      if (!view) return;
      if (view.status !== "blocked" || (view.failures?.length ?? 0) === 0) {
        if (view.status === "waiting") {
          console.log(`[run ${runId.slice(4, 12)}] unattended: parked on a human gate with no auto-pass predicate -- cannot self-resolve`);
        }
        return;
      }
      if (round >= maxRetries) {
        console.log(
          `[run ${runId.slice(4, 12)}] unattended: still blocked after ${maxRetries} auto-retries, giving up -- ` +
            `needs operator attention: ${view.failures.map((f) => f.error).join("; ")}`,
        );
        return;
      }
      console.log(`[run ${runId.slice(4, 12)}] unattended: auto-resuming a blocked attempt (retry ${round + 1}/${maxRetries})`);
      await this.retry(runId);
    }
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
    if (graph.startsWith("manual")) return "production";
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
    // Node-level detail is only meaningful when the run used a graph we are
    // currently holding, at the exact version we hold it. For anything else —
    // a measure run, or a skeleton/manual version since superseded — report
    // the run without pretending to know its steps.
    const matchedGraph = [this.graph, this.manualGraph].find(
      (g) => `${g.graph_id}@${g.version}` === runGraph,
    );

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

  /**
   * Close out a run row.
   *
   * Only the production drive() path did this, so measurement and discovery
   * runs sat at "running" forever — visible on the server as measure@1 rows
   * that never finish. Harmless to the artifacts, but it makes the runs table
   * lie about what is in flight, which is exactly the thing an operator checks
   * when something seems stuck.
   */
  private async closeRun(runId: string, status: string, error?: string | null): Promise<void> {
    if (!(this.runLog instanceof PgRunLog)) return;
    await this.runLog.updateRunStatus(runId, status, error ?? null);
    const cost = rollup(await this.runLog.forRun(runId)).cost_usd;
    await this.runLog.updateRunCost(runId, cost);
  }

  /**
   * Measure every published episode.
   *
   * Detached from production on purpose: a video measured an hour after upload
   * tells you nothing, so this is triggered separately (by you, or later by the
   * scheduler) rather than tacked onto the end of a run.
   *
   * One episode failing does not stop the rest — a single deleted or private
   * video must not block the whole feedback loop.
   */
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

    // Collect candidates first so visibility can be checked in one batch.
    const candidates: Array<{ artifactId: string; externalId: string }> = [];
    for (const row of rows) {
      const episode = await this.store.get(row.artifact_id);
      if (!episode) continue;
      const externalId = (episode.payload as { external_id?: string }).external_id;
      if (!externalId || seen.has(externalId)) continue;
      seen.add(externalId);
      candidates.push({ artifactId: row.artifact_id, externalId });
    }

    // PUBLIC CONTENT ONLY.
    //
    // Episodes are uploaded private and made public by hand, so the privacy
    // recorded on the artifact is stale the moment that happens — visibility is
    // read live instead. A private or unlisted video accrues no impressions and
    // barely any views, so measuring it would feed the strategist zeros that
    // look like failure and drag every median down.
    const analytics = this.analyticsProvider;
    let visibility: Record<string, string> = {};
    if (analytics && candidates.length > 0) {
      try {
        visibility = await analytics.fetchVisibility(candidates.map((c) => c.externalId));
      } catch {
        // Leave empty; each candidate then reads as "unknown" and is skipped
        // rather than measured on a guess.
        visibility = {};
      }
    }

    // Operator exclusions come first: a test upload should not cost an API call
    // or leave an artifact, regardless of how public it is.
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

      // Declared outside the try so the catch can close the run out too.
      const runId = `run_${randomUUID()}`;
      try {
        // The measure graph is a real run and writes run records, so the run
        // row has to exist first — run_records.run_id has a foreign key onto
        // runs(run_id). startRun() does this for production runs; measurement
        // went straight to the executor and violated the constraint the moment
        // it met Postgres. Invisible on the filesystem run log, which has no
        // referential integrity to violate.
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

  /**
   * Propose topics for the next episode.
   *
   * A separate flow that stops at candidates. Choosing the subject is the
   * cheapest decision in the pipeline and the one that most decides whether the
   * result is worth making, so it stays with the operator rather than being
   * auto-selected into a run.
   */
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

  /**
   * Wire up recurring jobs. Called explicitly by the entry point rather than in
   * create(), so importing the service in a test never starts timers.
   */
  startScheduler(opts: { tickMs?: number } = {}): Scheduler {
    const num = (key: string): number | null => {
      const raw = process.env[key]?.trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const jobs: Job[] = [
      {
        id: "measure",
        description: "Measure published episodes and feed the strategist",
        // Read-only, so it defaults on. 0 or a non-number disables it.
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
        description: "Pick the top discovery candidate, produce it and publish it — fully automated, one episode per tick",
        everyHours: num("SCHEDULE_PRODUCE_HOURS") ?? 24,
        // ON by default (once a day): every human_gate in illustrated_story.json
        // is `auto_pass_if: always`, so a started run drives itself all the way
        // to a public publish with no human step left to skip. Set
        // SCHEDULE_PRODUCE_HOURS=0 to turn this off; the operator can still use
        // the UI's "Create episode" to start additional episodes any time —
        // this job only decides the topic for the *scheduled* one.
        enabled: process.env["SCHEDULE_PRODUCE_HOURS"]?.trim() !== "0",
        run: async () => {
          const found = await this.discoverTopics();
          const top = (found.candidates as { candidates?: Array<{ brief?: string; genre?: Genre }> } | null)
            ?.candidates?.[0];
          if (!top?.brief) {
            console.log("[scheduler] discovery returned no candidate; not starting a run");
            return;
          }
          const runId = await this.startRun(top.brief, undefined, top.genre ? { genre: top.genre } : {});
          console.log(`[scheduler] started ${runId} for: ${top.brief} -- driving unattended through to publish`);
          // startRun only kicks the graph off in the background (this.drive is
          // fire-and-forget so the UI never blocks on a multi-minute run); a
          // scheduled tick has no UI watching it, so this job's own run() must
          // await the whole thing, auto-resuming past blocked attempts, or the
          // Scheduler would consider "produce" done the instant the run started.
          await this.driveUnattended(runId);
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
