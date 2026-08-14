/**
 * Execution graph (RFC 0005).
 *
 * Topology is versioned data, not code and not n8n node wiring. Because it is
 * data, a graph can be validated statically: arity, schema compatibility, and
 * cycles are all caught before a single token is spent.
 */

import { readFile } from "node:fs/promises";
import type { SchemaRegistry } from "./registry.ts";
import type { TransformationDef } from "./runner.ts";
import { parsePredicate } from "./predicate.ts";

export class GraphError extends Error {
  override name = "GraphError";
}

export interface InputNode {
  id: string;
  type: "input";
  schema_id: string;
}

export interface TransformationNode {
  id: string;
  type?: "transformation";
  transformation: string;
  /** Upstream node ids, positionally bound to the transformation's consumes[]. */
  in: string[];
  /** Reuse a matching output from a previous run instead of re-executing. */
  reuse?: boolean;
  labels?: Record<string, string>;
}

export interface HumanGateNode {
  id: string;
  type: "human_gate";
  /** Exactly one input; the gate passes it through unchanged when approved. */
  in: string[];
  policy?: {
    /** Declared predicate, e.g. "confidence.overall >= 0.9" (RFC 0005). */
    auto_pass_if?: string;
  };
}

export type GraphNode = InputNode | TransformationNode | HumanGateNode;

export interface GraphDoc {
  graph_id: string;
  version: string;
  description?: string;
  nodes: GraphNode[];
}

export function nodeType(n: GraphNode): "input" | "transformation" | "human_gate" {
  return n.type ?? "transformation";
}

export function inputsOf(n: GraphNode): string[] {
  return nodeType(n) === "input" ? [] : ((n as TransformationNode | HumanGateNode).in ?? []);
}

export function graphRef(g: GraphDoc): string {
  return `${g.graph_id}@${g.version}`;
}

export async function loadGraph(file: string): Promise<GraphDoc> {
  const doc = JSON.parse(await readFile(file, "utf8")) as GraphDoc;
  if (!doc.graph_id || !doc.version || !Array.isArray(doc.nodes)) {
    throw new GraphError(`${file}: graph_id, version, and nodes[] are required`);
  }
  return doc;
}

export interface ValidateGraphDeps {
  registry: SchemaRegistry;
  transformations: Map<string, TransformationDef>;
}

/**
 * Static validation. This is the payoff of topology-as-data: a mis-wired
 * pipeline fails at boot with a precise message instead of halfway through a
 * paid run.
 */
export function validateGraph(graph: GraphDoc, deps: ValidateGraphDeps): void {
  const problems: string[] = [];
  const byId = new Map<string, GraphNode>();

  for (const n of graph.nodes) {
    if (byId.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }

  // Unsupported node types are rejected loudly rather than silently skipped.
  for (const n of graph.nodes) {
    const t = (n as { type?: string }).type;
    if (t && !["input", "transformation", "human_gate"].includes(t)) {
      problems.push(
        `node "${n.id}" has type "${t}"; fanout/select are specified in RFC 0005 but ` +
          `not implemented yet`,
      );
    }
  }

  for (const n of graph.nodes) {
    for (const upstream of inputsOf(n)) {
      if (!byId.has(upstream)) {
        problems.push(`node "${n.id}" references unknown input "${upstream}"`);
      }
    }
  }

  // Cycle detection (iterative DFS; a graph is a DAG by definition).
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      problems.push(`cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    state.set(id, 1);
    for (const up of inputsOf(byId.get(id)!)) {
      if (byId.has(up)) visit(up, [...trail, id]);
    }
    state.set(id, 2);
  };
  for (const n of graph.nodes) visit(n.id, []);

  // What schema does each node emit?
  const emits = (id: string): string | null => {
    const n = byId.get(id);
    if (!n) return null;
    switch (nodeType(n)) {
      case "input":
        return (n as InputNode).schema_id;
      case "human_gate": {
        const up = inputsOf(n)[0];
        return up ? emits(up) : null;
      }
      default: {
        const def = deps.transformations.get((n as TransformationNode).transformation);
        return def ? def.produces : null;
      }
    }
  };

  for (const n of graph.nodes) {
    const kind = nodeType(n);

    if (kind === "input") {
      const schemaId = (n as InputNode).schema_id;
      if (!schemaId) problems.push(`input node "${n.id}" needs schema_id`);
      else if (!deps.registry.has(schemaId)) {
        problems.push(`input node "${n.id}" declares unknown schema "${schemaId}"`);
      }
      continue;
    }

    if (kind === "human_gate") {
      const gate = n as HumanGateNode;
      if (inputsOf(gate).length !== 1) {
        problems.push(`human_gate "${n.id}" must have exactly one input`);
      }
      if (gate.policy?.auto_pass_if) {
        try {
          parsePredicate(gate.policy.auto_pass_if);
        } catch (err) {
          problems.push(`human_gate "${n.id}": ${String(err)}`);
        }
      }
      continue;
    }

    const tn = n as TransformationNode;
    const def = deps.transformations.get(tn.transformation);
    if (!def) {
      problems.push(`node "${n.id}" references unknown transformation "${tn.transformation}"`);
      continue;
    }
    if (inputsOf(tn).length !== def.consumes.length) {
      problems.push(
        `node "${n.id}" supplies ${inputsOf(tn).length} input(s) but "${tn.transformation}" ` +
          `consumes ${def.consumes.length}`,
      );
      continue;
    }
    // Type-check every edge against the schema registry.
    for (const [i, spec] of def.consumes.entries()) {
      const upstreamId = inputsOf(tn)[i]!;
      const produced = emits(upstreamId);
      if (produced === null) continue; // already reported
      if (produced !== spec.schema_id) {
        problems.push(
          `node "${n.id}" input ${i} comes from "${upstreamId}" which emits "${produced}", ` +
            `but "${tn.transformation}" expects "${spec.schema_id}"`,
        );
        continue;
      }
      if (spec.range) {
        try {
          deps.registry.assertCompatible(
            produced,
            deps.registry.resolveVersion(produced),
            spec.range,
          );
        } catch (err) {
          problems.push(`node "${n.id}" input ${i}: ${String(err)}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new GraphError(`graph ${graphRef(graph)} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Node ids reachable downstream of `from`, inclusive of nothing else. */
export function descendantsOf(graph: GraphDoc, from: Set<string>): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      if (out.has(n.id)) continue;
      if (inputsOf(n).some((up) => from.has(up) || out.has(up))) {
        out.add(n.id);
        changed = true;
      }
    }
  }
  return out;
}
