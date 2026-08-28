/**
 * Artifact schema registry (RFC 0007).
 *
 * One versioned schema per artifact type, loaded from disk at boot. The same
 * JSON Schema is used for three things: provider-side structured output
 * (RFC 0004), validation on write, and validation on read. One definition,
 * three enforcement points, no drift.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import RawAjv2020 from "ajv/dist/2020.js";
import rawAddFormats from "ajv-formats";
import semver from "semver";

// ajv and ajv-formats ship CommonJS; interop differs by loader.
const Ajv2020 = ((RawAjv2020 as unknown as { default?: unknown }).default ??
  RawAjv2020) as typeof RawAjv2020;
const addFormats = ((rawAddFormats as unknown as { default?: unknown }).default ??
  rawAddFormats) as typeof rawAddFormats;

export type SchemaStatus = "draft" | "active" | "deprecated" | "retired";

export interface SchemaEntry {
  schema_id: string;
  version: string;
  status: SchemaStatus;
  description?: string;
  /** Transformations permitted to emit this type. Empty/absent = unrestricted. */
  produced_by?: string[];
  json_schema: Record<string, unknown>;
}

export class SchemaRegistryError extends Error {
  override name = "SchemaRegistryError";
}

export class SchemaValidationError extends Error {
  override name = "SchemaValidationError";
  constructor(
    message: string,
    readonly schemaId: string,
    readonly schemaVersion: string,
    /** Human-readable validation failures, suitable for feeding back to an agent retry. */
    readonly errors: string[],
  ) {
    super(message);
  }
}

interface Validator {
  entry: SchemaEntry;
  validate: (data: unknown) => boolean;
  lastErrors: () => string[];
}

export class SchemaRegistry {
  private readonly byId = new Map<string, Map<string, Validator>>();

  private constructor(private readonly ajv: InstanceType<typeof Ajv2020>) {}

  /**
   * Load every `<dir>/<schema_id>/<version>.json` registry entry.
   * Fails loudly on malformed entries — a bad schema at boot is better than a
   * bad artifact at runtime.
   */
  static async load(dir: string): Promise<SchemaRegistry> {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    addFormats(ajv as never);
    const registry = new SchemaRegistry(ajv);

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new SchemaRegistryError(`cannot read schema directory ${dir}: ${String(err)}`);
    }

    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const schemaId = d.name;
      const files = await readdir(path.join(dir, schemaId));
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const full = path.join(dir, schemaId, file);
        const entry = JSON.parse(await readFile(full, "utf8")) as SchemaEntry;
        registry.register(entry, { schemaId, fileVersion: file.replace(/\.json$/, ""), full });
      }
    }

    if (registry.byId.size === 0) {
      throw new SchemaRegistryError(`no schemas found under ${dir}`);
    }
    return registry;
  }

  private register(
    entry: SchemaEntry,
    ctx: { schemaId: string; fileVersion: string; full: string },
  ): void {
    if (entry.schema_id !== ctx.schemaId) {
      throw new SchemaRegistryError(
        `${ctx.full}: schema_id "${entry.schema_id}" does not match directory "${ctx.schemaId}"`,
      );
    }
    if (entry.version !== ctx.fileVersion) {
      throw new SchemaRegistryError(
        `${ctx.full}: version "${entry.version}" does not match filename "${ctx.fileVersion}"`,
      );
    }
    if (!semver.valid(entry.version)) {
      throw new SchemaRegistryError(`${ctx.full}: version must be semver, got "${entry.version}"`);
    }
    if (!["draft", "active", "deprecated", "retired"].includes(entry.status)) {
      throw new SchemaRegistryError(`${ctx.full}: invalid status "${entry.status}"`);
    }

    let compiled;
    try {
      compiled = this.ajv.compile(entry.json_schema);
    } catch (err) {
      throw new SchemaRegistryError(`${ctx.full}: json_schema failed to compile: ${String(err)}`);
    }

    const versions = this.byId.get(entry.schema_id) ?? new Map<string, Validator>();
    if (versions.has(entry.version)) {
      throw new SchemaRegistryError(`duplicate schema ${entry.schema_id}@${entry.version}`);
    }
    versions.set(entry.version, {
      entry,
      validate: (data) => compiled(data) as boolean,
      lastErrors: () =>
        (compiled.errors ?? []).map((e) => {
          // ajv's own `message` omits the one detail a retry actually needs for
          // some keywords: "must NOT have additional properties" never names
          // the property, so an agent correcting a 50-item array from that
          // text alone has to guess which field to drop and which scene it's
          // even on -- real production evidence (dialogue_script_writer
          // burned all 3 retry attempts flailing at different scene indices
          // on the same underlying complaint) that this silently starved the
          // retry loop of the one fact it needed to converge.
          const extra =
            e.keyword === "additionalProperties" &&
            e.params &&
            typeof (e.params as { additionalProperty?: unknown }).additionalProperty === "string"
              ? ` (unexpected property: "${(e.params as { additionalProperty: string }).additionalProperty}")`
              : "";
          return `${e.instancePath || "$"} ${e.message ?? "is invalid"}${extra}`.trim();
        }),
    });
    this.byId.set(entry.schema_id, versions);
  }

  has(schemaId: string): boolean {
    return this.byId.has(schemaId);
  }

  list(): SchemaEntry[] {
    return [...this.byId.values()].flatMap((m) => [...m.values()].map((v) => v.entry));
  }

  /**
   * Resolve a concrete version.
   * With no range: the highest `active` version.
   * With a range (e.g. "^1"): the highest satisfying version that is not retired,
   * preferring active over draft/deprecated.
   */
  resolveVersion(schemaId: string, range?: string): string {
    const versions = this.byId.get(schemaId);
    if (!versions) throw new SchemaRegistryError(`unknown schema id "${schemaId}"`);

    const usable = [...versions.values()].filter((v) => v.entry.status !== "retired");
    const candidates = range
      ? usable.filter((v) => semver.satisfies(v.entry.version, range))
      : usable.filter((v) => v.entry.status === "active");

    if (candidates.length === 0) {
      throw new SchemaRegistryError(
        range
          ? `no non-retired version of "${schemaId}" satisfies "${range}"`
          : `no active version of "${schemaId}"`,
      );
    }
    const rank = (s: SchemaStatus) => (s === "active" ? 0 : s === "draft" ? 1 : 2);
    candidates.sort(
      (a, b) =>
        rank(a.entry.status) - rank(b.entry.status) ||
        semver.rcompare(a.entry.version, b.entry.version),
    );
    return candidates[0]!.entry.version;
  }

  entry(schemaId: string, version: string): SchemaEntry {
    const found = this.byId.get(schemaId)?.get(version);
    if (!found) throw new SchemaRegistryError(`unknown schema ${schemaId}@${version}`);
    return found.entry;
  }

  /** The JSON Schema itself — handed to providers as the structured-output contract. */
  jsonSchema(schemaId: string, version?: string): Record<string, unknown> {
    const v = version ?? this.resolveVersion(schemaId);
    return this.entry(schemaId, v).json_schema;
  }

  /** Throws SchemaValidationError with per-field messages an agent retry can consume. */
  validate(schemaId: string, version: string, payload: unknown): void {
    const found = this.byId.get(schemaId)?.get(version);
    if (!found) throw new SchemaRegistryError(`unknown schema ${schemaId}@${version}`);
    if (found.entry.status === "retired") {
      throw new SchemaRegistryError(`schema ${schemaId}@${version} is retired`);
    }
    if (!found.validate(payload)) {
      const errors = found.lastErrors();
      throw new SchemaValidationError(
        `payload does not satisfy ${schemaId}@${version}: ${errors.join("; ")}`,
        schemaId,
        version,
        errors,
      );
    }
  }

  /** Enforce the produced_by allowlist from the registry entry. */
  assertProducer(schemaId: string, version: string, transformation: string): void {
    const allow = this.entry(schemaId, version).produced_by;
    if (allow && allow.length > 0 && !allow.includes(transformation)) {
      throw new SchemaRegistryError(
        `transformation "${transformation}" may not produce ${schemaId}@${version} ` +
          `(allowed: ${allow.join(", ")})`,
      );
    }
  }

  /** Read-side compatibility check (RFC 0007: fail fast at the boundary). */
  assertCompatible(schemaId: string, version: string, range: string): void {
    if (!semver.satisfies(version, range)) {
      throw new SchemaRegistryError(
        `artifact is ${schemaId}@${version} but consumer requires "${range}"`,
      );
    }
  }
}
