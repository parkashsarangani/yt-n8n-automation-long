/**
 * Transformation runner (RFC 0003).
 *
 * One harness for every transformation. Reasoning agents are data — a
 * definition plus a prompt. Workers are code, because they have side effects.
 */

import { randomUUID } from "node:crypto";
import type { Artifact, BlobRef, Confidence, ProducedBy } from "./artifact.ts";
import type { BlobStore } from "./blobs.ts";
import { PromptStore } from "./prompts.ts";
import { agentSemanticValidationErrors, hasHardSemanticError, HARD_ERROR_PREFIX } from "./agent-validators.ts";
import { repairEnumValues } from "./schema-repair.ts";
import { repairMissingOutroFlag } from "./script-repair.ts";
import { promptInputView } from "./prompt-inputs.ts";
import {
  ProviderError,
  ProviderRefusal,
  ProviderRouter,
  wrapWithConfidence,
  type AnalyticsProvider,
  type ImageProvider,
  type MediaRenderer,
  type SpeechProvider,
  type Usage,
} from "./provider.ts";
import { SchemaRegistry, SchemaValidationError } from "./registry.ts";
import type { ArtifactStore } from "./store.ts";
import type { RunLog, RunRecord, RunStatus } from "./runlog.ts";

export interface Consumes {
  schema_id: string;
  range?: string;
  as: string;
  optional?: boolean;
}

export interface AgentDef {
  name: string;
  kind: "agent";
  consumes: Consumes[];
  produces: string;
  produces_version?: string;
  prompt: string;
  model: {
    capability: string;
    max_output_tokens?: number;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    thinking?: boolean;
  };
  confidence_dimensions?: string[];
  retry?: { max_attempts?: number };
  version?: string;
}

export interface WorkerContext {
  logger: Pick<Console, "log" | "warn" | "error">;
  blobs: BlobStore;
  media: {
    speech?: SpeechProvider;
    images?: ImageProvider;
    renderer?: MediaRenderer;
    analytics?: AnalyticsProvider;
  };
  progress(note: { detail: string; job_id?: string }): Promise<void>;
  /**
   * 1 on this node's first execution for this run, incrementing each time a
   * prior execution of the SAME node_id in the SAME run recorded a "failed"
   * status. Lets a worker that gates on a quality bar (script_quality_release)
   * accept its best attempt after enough regenerations rather than blocking
   * a run forever on a bar the upstream generation keeps landing just under --
   * the same "accept the last attempt" escape hatch agents already have via
   * their own retry budget, extended to a deterministic worker that has no
   * retry loop of its own and depends on an operator forcing regeneration
   * upstream instead.
   */
  attemptNumber: number;
}

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
  blobs?: BlobStore;
  media?: {
    speech?: SpeechProvider;
    images?: ImageProvider;
    renderer?: MediaRenderer;
    analytics?: AnalyticsProvider;
  };
}

export class Runner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(def: TransformationDef, inputIds: string[], opts: RunOptions = {}): Promise<RunOutcome> {
    return def.kind === "agent"
      ? this.runAgent(def, inputIds, opts)
      : this.runWorker(def, inputIds, opts);
  }

  private async bindInputs(def: TransformationDef, inputIds: string[]): Promise<Record<string, Artifact>> {
    const requiredCount = def.consumes.filter((spec) => !spec.optional).length;
    if (inputIds.length < requiredCount || inputIds.length > def.consumes.length) {
      const expected = requiredCount === def.consumes.length
        ? String(def.consumes.length)
        : `${requiredCount}-${def.consumes.length}`;
      throw new RunnerError(`${def.name} consumes ${expected} artifact(s) but got ${inputIds.length}`);
    }

    const bound: Record<string, Artifact> = {};
    let inputIndex = 0;
    for (const [specIndex, spec] of def.consumes.entries()) {
      const requiredRemainingAfter = def.consumes
        .slice(specIndex + 1)
        .filter((candidate) => !candidate.optional).length;
      const suppliedRemaining = inputIds.length - inputIndex;
      if (spec.optional && suppliedRemaining <= requiredRemainingAfter) continue;

      const id = inputIds[inputIndex]!;
      inputIndex += 1;
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

  private async runAgent(def: AgentDef, inputIds: string[], opts: RunOptions): Promise<RunOutcome> {
    const runId = opts.runId ?? `run_${randomUUID()}`;
    const maxAttempts = def.retry?.max_attempts ?? 3;
    const version = this.outputVersion(def);
    const transformationVersion = def.version ?? "1";

    const inputs = await this.bindInputs(def, inputIds);
    const provider = this.deps.providers.forCapability(def.model.capability);
    const rawOutputSchema = this.deps.registry.jsonSchema(def.produces, version);
    const outputSchema = wrapWithConfidence(rawOutputSchema, def.confidence_dimensions ?? []);

    const vars: Record<string, string> = {};
    for (const [name, artifact] of Object.entries(inputs)) {
      vars[name] = JSON.stringify(promptInputView(def.name, name, artifact.payload), null, 2);
    }
    for (const spec of def.consumes) {
      if (spec.optional && !(spec.as in vars)) vars[spec.as] = "null";
    }

    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      const prompt = this.deps.prompts.render(def.prompt, vars) + renderRetryBlock(lastErrors);

      let value: unknown;
      let usage: Usage | null = null;
      let providerRef: string | null = null;

      try {
        const result = await provider.complete({
          prompt,
          outputSchema,
          ...(def.model.max_output_tokens ? { maxOutputTokens: def.model.max_output_tokens } : {}),
          ...(def.model.effort ? { effort: def.model.effort } : {}),
          ...(def.model.thinking === false ? { thinking: false } : {}),
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
          retry_reason: "provider",
        });
        if (refusal || attempt === maxAttempts) throw err;
        continue;
      }

      let rawPayload: unknown;
      let confidence: Confidence;
      try {
        ({ payload: rawPayload, confidence } = unwrap(value, def.name));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        // unwrap() failing (missing "payload", or a malformed/out-of-range
        // confidence.overall) used to propagate straight out of this loop,
        // skipping the retry-with-feedback path entirely: no run_records
        // entry, no chance for the model to see and fix the problem, and a
        // hard failure on attempt 1 regardless of max_attempts -- a run
        // needed a manual top-level retry every time this happened, and each
        // retry gave the model a genuinely fresh attempt 1 rather than the
        // in-agent retry budget doing its job. Treated the same as a schema
        // validation failure now: recorded, fed back via lastErrors, and
        // retried within this agent's own attempt budget.
        lastErrors = [err.message];
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
          confidence: null,
          started_at: startedAt,
          startedMs,
          error: err.message,
          retry_reason: "schema",
        });
        this.deps.logger?.warn(
          `[${def.name}] attempt ${attempt}/${maxAttempts} failed to unwrap response: ${err.message}`,
        );
        if (attempt === maxAttempts) {
          throw new RunnerError(
            `${def.name} produced an invalid ${def.produces} after ${maxAttempts} attempts: ${err.message}`,
          );
        }
        continue;
      }
      const { data: enumRepaired, repairs } = repairEnumValues(rawOutputSchema, rawPayload);
      if (repairs.length > 0) {
        this.deps.logger?.warn(
          `[${def.name}] attempt ${attempt}/${maxAttempts} auto-repaired ${repairs.length} enum value(s): ` +
            repairs.map((r) => `${r.path}: "${r.from}" -> "${r.to}"`).join("; "),
        );
      }
      // "Fix what the system already knows how to fix, don't spend a retry
      // attempt on it" -- for the one real production mistake the script
      // writers keep making: writing the outro scene's real content in the
      // correct final position and simply omitting is_outro:true. See
      // repairMissingOutroFlag's own comment for the production evidence and
      // why the repair stays conservative.
      const { data: payload, repairs: outroRepairs } = def.produces === "script"
        ? repairMissingOutroFlag(enumRepaired)
        : { data: enumRepaired, repairs: [] };
      if (outroRepairs.length > 0) {
        this.deps.logger?.warn(
          `[${def.name}] attempt ${attempt}/${maxAttempts} auto-repaired the missing outro flag: ` +
            outroRepairs.map((r) => `${r.path}: ${r.from} -> ${r.to}`).join("; "),
        );
      }

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
          retry_reason: "schema",
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

      const semanticErrors = agentSemanticValidationErrors(def, payload, inputs);
      // The HARD: marker is an internal routing signal, never user-facing text.
      const displayErrors = semanticErrors.map((e) => e.startsWith(HARD_ERROR_PREFIX) ? e.slice(HARD_ERROR_PREFIX.length) : e);
      if (semanticErrors.length > 0 && attempt < maxAttempts) {
        lastErrors = displayErrors;
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
          error: displayErrors.join("; "),
          retry_reason: classifyRetryReason(displayErrors),
          // Semantic gate rejections only ever recorded the error message,
          // never the payload that triggered it -- undiagnosable after the
          // fact without re-running (real cost) or guessing. The schema
          // path above doesn't need this: SchemaValidationError already
          // names the offending path/value per error.
          detail: JSON.stringify(payload).slice(0, 50_000),
        });
        this.deps.logger?.warn(
          `[${def.name}] attempt ${attempt}/${maxAttempts} failed semantic validation: ${displayErrors.join("; ")}`,
        );
        continue;
      }
      // Schema-valid but still failing the quality gate on the last attempt.
      // For a soft gate (style/quality, e.g. natural-dialogue phrasing),
      // accept it rather than throwing away a structurally sound artifact and
      // blocking the whole run. A hard gate is different: it mirrors an
      // unconditional throw with no retry in a downstream worker, so
      // accepting the artifact does not avoid the block -- it just spends one
      // more attempt arriving at the identical permanent block one stage
      // later (production case: run_39850b3e's visual_plan was accepted with
      // an incompatible operation/primitive pair on attempt 3/3, and the
      // compiler rejected the stored artifact with no way to recover).
      if (semanticErrors.length > 0 && hasHardSemanticError(semanticErrors)) {
        throw new RunnerError(
          `${def.name} produced a ${def.produces} that still fails a hard validation rule after ${maxAttempts} attempts: ${displayErrors.join("; ")}`,
        );
      }
      if (semanticErrors.length > 0) {
        this.deps.logger?.warn(
          `[${def.name}] attempt ${attempt}/${maxAttempts} (final) accepted despite failing semantic validation: ${displayErrors.join("; ")}`,
        );
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
        status: deduped ? "cache_hit" : semanticErrors.length > 0 ? "accepted_below_quality_bar" : "ok",
        attempt,
        max_attempts: maxAttempts,
        provider: provider.id,
        model: usage?.model ?? null,
        prompt_ref: def.prompt,
        usage,
        confidence,
        started_at: startedAt,
        startedMs,
        error: displayErrors.length > 0 ? displayErrors.join("; ") : null,
        retry_reason: displayErrors.length > 0 ? classifyRetryReason(displayErrors) : null,
      });

      return { artifact, runId, attempts: attempt, deduped };
    }

    throw new RunnerError(`${def.name} exhausted ${maxAttempts} attempts`);
  }

  private async runWorker(def: WorkerDef, inputIds: string[], opts: RunOptions): Promise<RunOutcome> {
    const runId = opts.runId ?? `run_${randomUUID()}`;
    const version = this.outputVersion(def);
    const transformationVersion = def.version ?? "1";
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const inputs = await this.bindInputs(def, inputIds);

    if (!this.deps.blobs) {
      throw new RunnerError(`worker "${def.name}" needs a blob store; construct the Runner with { blobs }`);
    }

    const priorFailures = opts.nodeId
      ? (await this.deps.runLog.all()).filter(
          (r) => r.run_id === runId && r.node_id === opts.nodeId && r.status === "failed",
        ).length
      : 0;

    const ctx: WorkerContext = {
      logger: this.deps.logger ?? console,
      blobs: this.deps.blobs,
      media: this.deps.media ?? {},
      attemptNumber: priorFailures + 1,
      progress: async (note) => {
        await this.deps.runLog.record({
          run_id: runId,
          graph_id: opts.graphId ?? null,
          node_id: opts.nodeId ?? null,
          transformation: def.name,
          transformation_version: transformationVersion,
          inputs: inputIds,
          output: null,
          status: "running",
          attempt: 1,
          max_attempts: 1,
          started_at: new Date().toISOString(),
          duration_ms: Date.now() - startedMs,
          error: null,
          ...(note.job_id ? { external_job_id: note.job_id } : {}),
          detail: note.detail,
        });
      },
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
    throw new ProviderError(`${agent} response is missing a valid confidence.overall in [0,1]`);
  }
  return { payload: v.payload, confidence: v.confidence as Confidence };
}

function renderRetryBlock(errors: string[]): string {
  if (errors.length === 0) return "";
  return (
    `\n\n---\n## Your previous attempt was rejected\n\n` +
    `It failed schema or semantic validation with these errors:\n` +
    errors.map((e) => `- ${e}`).join("\n") +
    `\n\nFix exactly these problems and return the corrected result. ` +
    `Do not change anything else, and do not explain the fix.\n`
  );
}


function classifyRetryReason(errors: string[]): "natural_dialogue" | "story_contract" | "visual_explanation" | "other_semantic" {
  const text = errors.join(" ").toLowerCase();
  if (/natural dialogue|robotic|duplicate dialogue|short lines|human moment|definition\/explainer/.test(text)) return "natural_dialogue";
  if (/contract violated|payoff|resolution|midpoint|engagement beat|function order|teach-back/.test(text)) return "story_contract";
  if (/visual|prop|doorway|crossing|foreground_action|physical demonstration/.test(text)) return "visual_explanation";
  return "other_semantic";
}
