/**
 * Artifact envelope and identity (RFC 0002).
 *
 * Artifacts are immutable and content-addressed. Identity is derived from the
 * typed content only — schema id, schema version, payload — and deliberately
 * NOT from parentage, producer, confidence, or timestamps. Producing the same
 * content twice yields the same artifact.
 */

import { canonicalHash } from "./canonical.ts";

export const ARTIFACT_ID_PREFIX = "sha256:";

export interface ProducedBy {
  /** Agent or worker name, e.g. "story_architect". */
  transformation: string;
  /** Transformation version — bump when behaviour changes (RFC 0001). */
  version: string;
  /** Links to the run record (RFC 0006). */
  run_id: string;
  /** Concrete resolved model for agents; null for workers (RFC 0004). */
  provider?: string | null;
  /** Pinned prompt reference for agents, e.g. "story_architect@4". */
  prompt_ref?: string | null;
}

export interface Confidence {
  /** Self-assessed, in [0,1]. A routing signal, never evidence (RFC 0006). */
  overall: number;
  dimensions?: Record<string, number>;
}

export interface BlobRef {
  /** e.g. "video", "audio", "image", "thumbnail". */
  role: string;
  /** blob://sha256:... */
  uri: string;
  bytes?: number;
  media_type?: string;
}

export interface Artifact<P = unknown> {
  artifact_id: string;
  schema_id: string;
  schema_version: string;
  produced_by: ProducedBy;
  /** Every artifact actually consumed, in order (RFC 0002). */
  parents: string[];
  confidence?: Confidence | null;
  /** ISO 8601 UTC. */
  created_at: string;
  /** Grouping and experiment labels, e.g. { lineage_id, variant }. */
  labels: Record<string, string>;
  payload: P;
  blobs?: BlobRef[];
}

/** Everything the caller supplies; identity and timestamps are derived. */
export interface ArtifactInput<P = unknown> {
  schema_id: string;
  /** Omit to resolve the registry's current active version. */
  schema_version?: string;
  payload: P;
  produced_by: ProducedBy;
  parents?: string[];
  confidence?: Confidence | null;
  labels?: Record<string, string>;
  blobs?: BlobRef[];
}

/**
 * Content address for an artifact.
 *
 * Hashes the canonical form of `{payload, schema_id, schema_version}` — a
 * wrapper object rather than a concatenation, so the boundary between the
 * fields is unambiguous and no payload can impersonate a different schema.
 */
export function computeArtifactId(
  schemaId: string,
  schemaVersion: string,
  payload: unknown,
): string {
  return (
    ARTIFACT_ID_PREFIX +
    canonicalHash({ schema_id: schemaId, schema_version: schemaVersion, payload })
  );
}

export function isArtifactId(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Build a sealed envelope. Callers go through the store, which also validates. */
export function sealArtifact<P>(
  input: ArtifactInput<P> & { schema_version: string },
  now: Date = new Date(),
): Artifact<P> {
  const artifact_id = computeArtifactId(input.schema_id, input.schema_version, input.payload);
  return {
    artifact_id,
    schema_id: input.schema_id,
    schema_version: input.schema_version,
    produced_by: input.produced_by,
    parents: input.parents ?? [],
    confidence: input.confidence ?? null,
    created_at: now.toISOString(),
    labels: input.labels ?? {},
    payload: input.payload,
    ...(input.blobs && input.blobs.length > 0 ? { blobs: input.blobs } : {}),
  };
}

export class ArtifactError extends Error {
  override name = "ArtifactError";
}

/** Structural checks on the envelope itself (the payload is the registry's job). */
export function assertEnvelopeWellFormed(a: Artifact): void {
  if (!isArtifactId(a.artifact_id)) {
    throw new ArtifactError(`malformed artifact_id: ${a.artifact_id}`);
  }
  for (const p of a.parents) {
    if (!isArtifactId(p)) throw new ArtifactError(`malformed parent id: ${p}`);
  }
  if (new Set(a.parents).size !== a.parents.length) {
    throw new ArtifactError(`duplicate parent ids in ${a.artifact_id}`);
  }
  if (a.parents.includes(a.artifact_id)) {
    throw new ArtifactError(`artifact ${a.artifact_id} lists itself as a parent`);
  }
  if (!a.produced_by?.transformation || !a.produced_by?.version || !a.produced_by?.run_id) {
    throw new ArtifactError(`produced_by must carry transformation, version, and run_id`);
  }
  if (a.confidence != null) {
    const { overall } = a.confidence;
    if (typeof overall !== "number" || !(overall >= 0 && overall <= 1)) {
      throw new ArtifactError(`confidence.overall must be in [0,1], got ${String(overall)}`);
    }
  }
  const recomputed = computeArtifactId(a.schema_id, a.schema_version, a.payload);
  if (recomputed !== a.artifact_id) {
    throw new ArtifactError(
      `artifact_id does not match content: declared ${a.artifact_id}, computed ${recomputed}`,
    );
  }
}
