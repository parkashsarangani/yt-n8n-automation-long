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
    // De-duplicated, order preserved. Content-addressed identity means two
    // DIFFERENT declared inputs can legitimately resolve to the SAME
    // artifact -- explanation_plan_release (RFC review gate) binds
    // [visual_plan, plan_revision, plan_review]; when the reviser's genuine
    // answer is "nothing needed changing" its output is byte-identical to
    // visual_plan, and content addressing gives it the identical artifact
    // id. That produced two equal entries in parents and crashed a run on a
    // legitimate reviser no-op ("duplicate parent ids in ..."), not on any
    // actual wiring bug. Same reasoning as the self-parent exemption in
    // assertEnvelopeWellFormed below: a hash collision is infeasible, so
    // equal ids here mean equal content, never corrupt provenance. Deduping
    // loses no information -- store.lineage() already walks parents through
    // a `seen` set, so a second identical entry was never adding anything a
    // consumer used.
    parents: [...new Set(input.parents ?? [])],
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
  // No duplicate-parents check here any more -- sealArtifact (the only
  // producer of a well-formed envelope; see store.put) already de-duplicates
  // parents, for the same content-addressing reason as the self-parent note
  // below. A caller that somehow bypasses sealArtifact and hands this
  // function a hand-built envelope with a literal duplicate is not sending
  // fresh information either: two equal ids are two equal ids, deduped or
  // not, and the store's lineage walk already treats them as one.
  // No self-parent check: artifact_id is a pure content hash of
  // {schema_id, schema_version, payload} (see computeArtifactId), never of
  // parentage. Since hash collisions are infeasible, `parents.includes(id)`
  // can only be true when one declared parent is already content-identical
  // to what's being produced now -- a normal, legitimate shape for an
  // approval/pass-through worker (script_quality_release consumes a script
  // and a report, and on a genuine pass returns the script unchanged; that
  // output necessarily has the same schema_id/schema_version/payload as the
  // script it consumed, hence the same artifact_id). A real run hit exactly
  // this the first time quality_release ever actually succeeded: rejecting
  // it here blocked a script that had genuinely cleared the quality bar,
  // for a check with no real logic bug behind it -- there is no OTHER way
  // for this condition to arise given how identity is derived, so it was
  // never actually protecting against anything a caller could get wrong.
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
