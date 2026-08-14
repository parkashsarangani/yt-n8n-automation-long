/**
 * Agent catalog.
 *
 * Agents are data (RFC 0003), so they load from disk rather than being
 * registered in code. Workers are code and register themselves.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDef, WorkerDef, TransformationDef } from "./runner.ts";

export class CatalogError extends Error {
  override name = "CatalogError";
}

export async function loadAgentDefs(dir: string): Promise<Map<string, AgentDef>> {
  const out = new Map<string, AgentDef>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    throw new CatalogError(`cannot read agent directory ${dir}: ${String(err)}`);
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(dir, file);
    const def = JSON.parse(await readFile(full, "utf8")) as AgentDef;

    if (def.kind !== "agent") {
      throw new CatalogError(`${full}: kind must be "agent"`);
    }
    if (def.name !== file.replace(/\.json$/, "")) {
      throw new CatalogError(`${full}: name "${def.name}" does not match its filename`);
    }
    if (!def.prompt?.includes("@")) {
      throw new CatalogError(`${full}: prompt must be pinned as "name@version"`);
    }
    if (!def.model?.capability) {
      throw new CatalogError(
        `${full}: model.capability is required — agents declare capabilities, ` +
          `never vendors or model ids (RFC 0004)`,
      );
    }
    if (!Array.isArray(def.consumes) || !def.produces) {
      throw new CatalogError(`${full}: consumes[] and produces are required`);
    }
    if (new Set(def.consumes.map((c) => c.as)).size !== def.consumes.length) {
      throw new CatalogError(`${full}: duplicate "as" names in consumes[]`);
    }
    if (out.has(def.name)) throw new CatalogError(`duplicate agent "${def.name}"`);
    out.set(def.name, def);
  }
  return out;
}

/** Cross-check the catalog against the schema registry and prompt store at boot. */
export interface CatalogChecks {
  hasSchema(schemaId: string): boolean;
  hasPrompt(ref: string): boolean;
}

export function validateCatalog(
  agents: Map<string, AgentDef>,
  checks: CatalogChecks,
): void {
  const problems: string[] = [];
  for (const def of agents.values()) {
    if (!checks.hasPrompt(def.prompt)) {
      problems.push(`agent "${def.name}" references missing prompt "${def.prompt}"`);
    }
    if (!checks.hasSchema(def.produces)) {
      problems.push(`agent "${def.name}" produces unknown schema "${def.produces}"`);
    }
    for (const c of def.consumes) {
      if (!checks.hasSchema(c.schema_id)) {
        problems.push(`agent "${def.name}" consumes unknown schema "${c.schema_id}"`);
      }
    }
  }
  if (problems.length > 0) {
    throw new CatalogError(`catalog is inconsistent:\n  - ${problems.join("\n  - ")}`);
  }
}

export function isAgent(def: TransformationDef): def is AgentDef {
  return def.kind === "agent";
}

export function isWorker(def: TransformationDef): def is WorkerDef {
  return def.kind === "worker";
}
