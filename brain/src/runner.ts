/**
 * Transformation runner (RFC 0003).
 *
 * One harness for every transformation. Reasoning agents are *data* — a
 * definition plus a prompt — so adding the eighth agent introduces no control
 * flow. Workers are code, because they have side effects.
 *
 * Rules 1 and 2 of RFC 0001 are enforced structurally: an agent is never given
 * a WorkerContext (no filesystem, no network), and a worker is never given a
 * ModelProvider. Violating either requires editing this file.
 */

import { randomUUID } from "node:crypto";
import type { Artifact, BlobRef, Confidence, ProducedBy } from "./artifact.ts";
import type { BlobStore } from "./blobs.ts";
import { PromptStore } from "./prompts.ts";
import {
  ProviderError,
  ProviderRefusal,
  ProviderRouter,
  wrapWithConfidence,
  type ImageProvider,
  type SpeechProvider,
  type Usage,
} from "./provider.ts";
import { SchemaRegistry, SchemaValidationError } from "./registry.ts";
import type { ArtifactStore } from "./store.ts";
import type { RunLog, RunRecord, RunStatus } from "./runlog.ts";

export interface Consumes {
  schema_id: string;
  /** semver range the consumer accepts, e.g. "^1". */
  range?: string;
  /** Name this input is bound to in the prompt, e.g. {{story}}. */
  as: string;
}

export interface AgentDef {
  name: string;
  kind: "agent";
  consumes: Consumes[];
  produces: string;
  produces_version?: string;
  /** "name@version" into the prompt store. */
  prompt: string;
  model: {
    capability: string;
    max_output_tokens?: number;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
  confidence_dimensions?: string[];
  retry?: { max_attempts?: number };
  /** Bumped when behaviour changes; recorded on every artifact. */
  version?: string;
}

/**
 * What a worker is allowed to touch: bytes, media services, a logger.
 *
 * Deliberately NOT extended with a ModelProvider. The runner constructs this,
 * so adding one requires editing the runner — a visible, reviewable act rather
 * than an accident inside a handler (RFC 0001 rule 1).
 *
 * Honest limitation: this proves nothing about dependencies a worker closes
 * over at construction time. The injected surface is enforced; construction is
 * still convention plus review.
 */
export interface WorkerContext {
  logger: Pick<Console, "log" | "warn" | "error">;
  blobs: BlobStore;
  media: {
    speech?: SpeechProvider;
    images?: ImageProvider;
  };
}

/** Workers declare the blobs they created so the envelope can own them. */
export interface WorkerOutput {
  payload: unknown;
  blobs?: BlobRef[];
}

export interface WorkerDef {
  name: string;
  kind: "worker";
  consumes: Consumes[];
  produces: string;
  produces_version?: string;
  version?: string;
  execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput>;
}

export type TransformationDef = AgentDef | WorkerDef;

export interface RunOptions {
  runId?: string;
  graphId?: string | null;
  nodeId?: string | null;
  labels?: Record<string, string>;
}

export interface RunOutcome {
  artifact: Artifact;
  runId: string;
  attempts: number;
  deduped: boolean;
}

export class RunnerError extends Error {
  override name = "RunnerError";
}

export interface RunnerDeps {
  store: ArtifactStore;
  registry: SchemaRegistry;
  prompts: PromptStore;
  providers: ProviderRouter;
  runLog: RunLog;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Required only if any worker produces bytes. */
  blobs?: BlobStore;
  media?: { speech?: SpeechProvider; images?: ImageProvider };
}

export class Runner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(
    def: TransformationDef,
    inputIds: string[],
    opts: RunOptions = {},
  ): Promise<RunOutcome> {
    return def.kind === "agent"
      ? this.runAgent(def, inputIds, opts)
      : this.runWorker(def, inputIds, opts);
  }

  // -- shared -------------------------------------------------------------

  /** Bind positional input ids to their declared names, validating on read. */
  private async bindInputs(
    def: TransformationDef,
    inputIds: string[],
  ): Promise<Record<string, Artifact>> {
    if (inputIds.length !== def.consumes.length) {
      throw new RunnerError(
        `${def.name} consumes ${def.consumes.length} artifact(s) but got ${inputIds.length}`,
      );
    }
    const bound: Record<string, Artifact> = {};
    for (const [i, spec] of def.consumes.entries()) {
      const id = inputIds[i]!;
      bound[spec.as] = await this.deps.store.require(id, {
        schema_id: spec.schema_id,
        ...(spec.range ? { range: spec.range } : {}),
      });
    }
    return bound;
  }

  private outputVersion(def: TransformationDef): string {
    return def.produces_version ?? this.deps.registry.resolveVersion(def.produces);
  }

  private async writeRecord(partial: Omit<RunRecord, "duration_ms"> & { startedMs: number }) {
    const { startedMs, ...rest } = partial;
    await this.deps.runLog.record({ ...rest, duration_ms: Date.now() - startedMs });
  }

  // -- agents -------------------------------------------------------------

  private async runAgent(
    def: AgentDef,
    inputIds: string[],
    opts: RunOptions,
  ): Promise<RunOutcome> {
    const runId = opts.runId ?? `run_${randomUUID()}`;
    const maxAttempts = def.retry?.max_attempts ?? 3;
    const version = this.outputVersion(def);
    const transformationVersion = def.version ?? "1";

    const inputs = await this.bindInputs(def, inputIds);
    const provider = this.deps.providers.forCapability(def.model.capability);

    // The provider sees payload+confidence; confidence stays out of the payload
    // so it cannot affect the content hash (RFC 0002).
    const outputSchema = wrapWithConfidence(
      this.deps.registry.jsonSchema(def.produces, version),
      def.confidence_dimensions ?? [],
    );

    const vars: Record<string, string> = {};
    for (const [name, artifact] of Object.entries(inputs)) {
      vars[name] = JSON.stringify(artifact.payload, null, 2);
    }

    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();

      // A retry MUST differ from the attempt that failed, or it fails
      // identically (RFC 0003). The validation errors are the difference.
      const prompt =
        this.deps.prompts.render(def.prompt, vars) + renderRetryBlock(lastErrors);

      let value: unknown;
      let usage: Usage | null = null;
      let providerRef: string | null = null;

      try {
        const result = await provider.complete({
          prompt,
          outputSchema,
          ...(def.model.max_output_tokens
            ? { maxOutputTokens: def.model.max_output_tokens }
            : {}),
          ...(def.model.effort ? { effort: def.model.effort } : {}),
        });
        value = result.value;
        usage = result.usage;
        providerRef = result.providerRef;
      } catch (err) {
        const refusal = err instanceof ProviderRefusal;
        await this.writeRecord({
          run_id: runId,
          graph_id: opts.graphId ?? null,
          node_id: opts.nodeId ?? null,
          transformation: def.name,
          transformation_version: transformationVersion,
          inputs: inputIds,
          output: null,
          status: (refusal ? "provider_refusal" : "provider_error") as RunStatus,
          attempt,
          max_attempts: maxAttempts,
          provider: provider.id,
          model: null,
          prompt_ref: def.prompt,
          usage: null,
          confidence: null,
          started_at: startedAt,
          startedMs,
          error: String(err),
        });
        // A refusal will not resolve by retrying the same prompt.
        if (refusal || attempt === maxAttempts) throw err;
        continue;
      }

      const { payload, confidence } = unwrap(value, def.name);

      try {
        this.deps.registry.validate(def.produces, version, payload);
      } catch (err) {
        if (!(err instanceof SchemaValidationError)) throw err;
        lastErrors = err.errors;
        await this.writeRecord({
          run_id: runId,
          graph_id: opts.graphId ?? null,
          node_id: opts.nodeId ?? null,
          transformation: def.name,
          transformation_version: transformationVersion,
          inputs: inputIds,
          output: null,
          status: "schema_invalid",
          attempt,
          max_attempts: maxAttempts,
          provider: provider.id,
          model: usage?.model ?? null,
          prompt_ref: def.prompt,
          usage,
          confidence,
          started_at: startedAt,
          startedMs,
          error: err.errors.join("; "),
        });
        this.deps.logger?.warn(
          `[${def.name}] attempt ${attempt}/${maxAttempts} failed validation: ${err.errors.join("; ")}`,
        );
        if (attempt === maxAttempts) {
          throw new RunnerError(
            `${def.name} produced an invalid ${def.produces} after ${maxAttempts} attempts: ` +
              err.errors.join("; "),
          );
        }
        continue;
      }

      const producedBy: ProducedBy = {
        transformation: def.name,
        version: transformationVersion,
        run_id: runId,
        provider: providerRef,
        prompt_ref: def.prompt,
      };

      const { artifact, deduped } = await this.deps.store.put({
        schema_id: def.produces,
        schema_version: version,
        payload,
        produced_by: producedBy,
        parents: inputIds,
        confidence,
        ...(opts.labels ? { labels: opts.labels } : {}),
      });

      await this.writeRecord({
        run_id: runId,
        graph_id: opts.graphId ?? null,
        node_id: opts.nodeId ?? null,
        transformation: def.name,
        transformation_version: transformationVersion,
        inputs: inputIds,
        output: artifact.artifact_id,
        status: deduped ? "cache_hit" : "ok",
        attempt,
        max_attempts: maxAttempts,
        provider: provider.id,
        model: usage?.model ?? null,
        prompt_ref: def.prompt,
        usage,
        confidence,
        started_at: startedAt,
        startedMs,
        error: null,
      });

      return { artifact, runId, attempts: attempt, deduped };
    }

    throw new RunnerError(`${def.name} exhausted ${maxAttempts} attempts`);
  }

  // -- workers ------------------------------------------------------------

  private async runWorker(
    def: WorkerDef,
    inputIds: string[],
    opts: RunOptions,
  ): Promise<RunOutcome> {
    const runId = opts.runId ?? `run_${randomUUID()}`;
    const version = this.outputVersion(def);
    const transformationVersion = def.version ?? "1";
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    const inputs = await this.bindInputs(def, inputIds);

    // Note what is absent: no ModelProvider. A worker cannot think (RFC 0001).
    if (!this.deps.blobs) {
      throw new RunnerError(
        `worker "${def.name}" needs a blob store; construct the Runner with { blobs }`,
      );
    }
    const ctx: WorkerContext = {
      logger: this.deps.logger ?? console,
      blobs: this.deps.blobs,
      media: this.deps.media ?? {},
    };

    let payload: unknown;
    let blobs: BlobRef[] | undefined;
    try {
      const out = await def.execute(inputs, ctx);
      payload = out.payload;
      blobs = out.blobs;
    } catch (err) {
      await this.writeRecord({
        run_id: runId,
        graph_id: opts.graphId ?? null,
        node_id: opts.nodeId ?? null,
        transformation: def.name,
        transformation_version: transformationVersion,
        inputs: inputIds,
        output: null,
        status: "failed",
        attempt: 1,
        max_attempts: 1,
        started_at: startedAt,
        startedMs,
        error: String(err),
      });
      throw err;
    }

    const { artifact, deduped } = await this.deps.store.put({
      schema_id: def.produces,
      schema_version: version,
      payload,
      produced_by: {
        transformation: def.name,
        version: transformationVersion,
        run_id: runId,
        provider: null,
      },
      parents: inputIds,
      ...(blobs && blobs.length > 0 ? { blobs } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
    });

    await this.writeRecord({
      run_id: runId,
      graph_id: opts.graphId ?? null,
      node_id: opts.nodeId ?? null,
      transformation: def.name,
      transformation_version: transformationVersion,
      inputs: inputIds,
      output: artifact.artifact_id,
      status: deduped ? "cache_hit" : "ok",
      attempt: 1,
      max_attempts: 1,
      started_at: startedAt,
      startedMs,
      error: null,
    });

    return { artifact, runId, attempts: 1, deduped };
  }
}

function unwrap(value: unknown, agent: string): { payload: unknown; confidence: Confidence } {
  if (value === null || typeof value !== "object") {
    throw new ProviderError(`${agent} returned a non-object response`);
  }
  const v = value as { payload?: unknown; confidence?: Confidence };
  if (!("payload" in v)) {
    throw new ProviderError(`${agent} response is missing "payload"`);
  }
  const overall = v.confidence?.overall;
  if (typeof overall !== "number" || !(overall >= 0 && overall <= 1)) {
    throw new ProviderError(
      `${agent} response is missing a valid confidence.overall in [0,1]`,
    );
  }
  return { payload: v.payload, confidence: v.confidence as Confidence };
}

function renderRetryBlock(errors: string[]): string {
  if (errors.length === 0) return "";
  return (
    `\n\n---\n## Your previous attempt was rejected\n\n` +
    `It failed schema validation with these errors:\n` +
    errors.map((e) => `- ${e}`).join("\n") +
    `\n\nFix exactly these problems and return the corrected result. ` +
    `Do not change anything else, and do not explain the fix.\n`
  );
}
