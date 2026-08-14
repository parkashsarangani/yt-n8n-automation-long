/**
 * Artifact store (RFC 0002).
 *
 * Enforces the invariants the rest of the system relies on:
 *  - validate on write, so no invalid artifact can exist
 *  - validate on read, so a consumer never silently gets an unexpected shape
 *  - immutable: an existing artifact id is never rewritten
 *  - content-addressed: producing the same content twice dedups
 *
 * The filesystem implementation below is deliberate for the walking skeleton:
 * zero infrastructure, and the content-addressed layout is the same shape a
 * Postgres implementation will take behind this interface (RFC 0002 §Storage).
 */

import { mkdir, readFile, rename, writeFile, appendFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  assertEnvelopeWellFormed,
  computeArtifactId,
  sealArtifact,
  type Artifact,
  type ArtifactInput,
} from "./artifact.ts";
import { SchemaRegistry } from "./registry.ts";

export interface ReadExpectation {
  schema_id: string;
  /** semver range, e.g. "^1". Omit to accept any non-retired version. */
  range?: string;
}

export interface PutResult<P = unknown> {
  artifact: Artifact<P>;
  /** True when this exact content already existed; the stored envelope was kept. */
  deduped: boolean;
}

export interface IndexRow {
  artifact_id: string;
  schema_id: string;
  schema_version: string;
  transformation: string;
  run_id: string;
  lineage_id: string | null;
  created_at: string;
}

export interface ArtifactStore {
  put<P>(input: ArtifactInput<P>): Promise<PutResult<P>>;
  get<P>(id: string): Promise<Artifact<P> | null>;
  require<P>(id: string, expect?: ReadExpectation): Promise<Artifact<P>>;
  /** Transitive ancestors, nearest first. Excludes the artifact itself. */
  lineage(id: string, opts?: { maxDepth?: number }): Promise<Artifact[]>;
  index(): Promise<IndexRow[]>;
}

export class ArtifactStoreError extends Error {
  override name = "ArtifactStoreError";
}

export class FsArtifactStore implements ArtifactStore {
  private constructor(
    private readonly root: string,
    private readonly registry: SchemaRegistry,
  ) {}

  static async open(root: string, registry: SchemaRegistry): Promise<FsArtifactStore> {
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await mkdir(path.join(root, "tmp"), { recursive: true });
    return new FsArtifactStore(root, registry);
  }

  private pathFor(id: string): string {
    const hex = id.slice("sha256:".length);
    return path.join(this.root, "artifacts", hex.slice(0, 2), `${hex}.json`);
  }

  async put<P>(input: ArtifactInput<P>): Promise<PutResult<P>> {
    const version = input.schema_version ?? this.registry.resolveVersion(input.schema_id);

    // Validate on write: an invalid payload never becomes an artifact (RFC 0007).
    this.registry.validate(input.schema_id, version, input.payload);
    this.registry.assertProducer(input.schema_id, version, input.produced_by.transformation);

    // Parents must exist. A dangling edge would break provenance silently.
    for (const parent of input.parents ?? []) {
      if (!(await this.get(parent))) {
        throw new ArtifactStoreError(
          `parent ${parent} does not exist (declared by ${input.produced_by.transformation})`,
        );
      }
    }

    const artifact = sealArtifact({ ...input, schema_version: version });
    assertEnvelopeWellFormed(artifact);

    const existing = await this.get<P>(artifact.artifact_id);
    if (existing) {
      // Immutable: the first envelope wins. The second production is still fully
      // recorded in the run log (RFC 0006), which is the authoritative per-run
      // provenance; the envelope's `parents` reflect the first producer.
      return { artifact: existing, deduped: true };
    }

    const dest = this.pathFor(artifact.artifact_id);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = path.join(this.root, "tmp", `${randomUUID()}.json`);
    await writeFile(tmp, JSON.stringify(artifact, null, 2), "utf8");
    await rename(tmp, dest);

    const row: IndexRow = {
      artifact_id: artifact.artifact_id,
      schema_id: artifact.schema_id,
      schema_version: artifact.schema_version,
      transformation: artifact.produced_by.transformation,
      run_id: artifact.produced_by.run_id,
      lineage_id: artifact.labels["lineage_id"] ?? null,
      created_at: artifact.created_at,
    };
    await appendFile(path.join(this.root, "index.jsonl"), `${JSON.stringify(row)}\n`, "utf8");

    return { artifact, deduped: false };
  }

  async get<P>(id: string): Promise<Artifact<P> | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const artifact = JSON.parse(raw) as Artifact<P>;

    // Detect tampering or bit-rot: the id is derived from the content, so a
    // mismatch means the file on disk is not what it claims to be.
    const recomputed = computeArtifactId(
      artifact.schema_id,
      artifact.schema_version,
      artifact.payload,
    );
    if (recomputed !== artifact.artifact_id || artifact.artifact_id !== id) {
      throw new ArtifactStoreError(
        `content hash mismatch for ${id}: stored content hashes to ${recomputed}`,
      );
    }
    return artifact;
  }

  async require<P>(id: string, expect?: ReadExpectation): Promise<Artifact<P>> {
    const artifact = await this.get<P>(id);
    if (!artifact) throw new ArtifactStoreError(`artifact not found: ${id}`);

    if (expect) {
      if (artifact.schema_id !== expect.schema_id) {
        throw new ArtifactStoreError(
          `expected schema "${expect.schema_id}" but ${id} is "${artifact.schema_id}"`,
        );
      }
      // Validate on read (RFC 0007): fail fast at the boundary.
      if (expect.range) {
        this.registry.assertCompatible(artifact.schema_id, artifact.schema_version, expect.range);
      }
      this.registry.validate(artifact.schema_id, artifact.schema_version, artifact.payload);
    }
    return artifact;
  }

  async lineage(id: string, opts: { maxDepth?: number } = {}): Promise<Artifact[]> {
    const maxDepth = opts.maxDepth ?? 64;
    const seen = new Set<string>([id]);
    const out: Artifact[] = [];
    let frontier = (await this.require(id)).parents;

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const parentId of frontier) {
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        const parent = await this.get(parentId);
        if (!parent) {
          throw new ArtifactStoreError(`lineage of ${id} references missing artifact ${parentId}`);
        }
        out.push(parent);
        next.push(...parent.parents);
      }
      frontier = next;
    }
    return out;
  }

  async index(): Promise<IndexRow[]> {
    try {
      const raw = await readFile(path.join(this.root, "index.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as IndexRow);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Rebuild index.jsonl from the artifact files (the files are the source of truth). */
  async reindex(): Promise<number> {
    const base = path.join(this.root, "artifacts");
    const rows: IndexRow[] = [];
    for (const shard of await readdir(base, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      for (const file of await readdir(path.join(base, shard.name))) {
        if (!file.endsWith(".json")) continue;
        const a = JSON.parse(
          await readFile(path.join(base, shard.name, file), "utf8"),
        ) as Artifact;
        rows.push({
          artifact_id: a.artifact_id,
          schema_id: a.schema_id,
          schema_version: a.schema_version,
          transformation: a.produced_by.transformation,
          run_id: a.produced_by.run_id,
          lineage_id: a.labels["lineage_id"] ?? null,
          created_at: a.created_at,
        });
      }
    }
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    await writeFile(
      path.join(this.root, "index.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
      "utf8",
    );
    return rows.length;
  }
}
