/**
 * Declared predicates over artifact fields (RFC 0005).
 *
 * Conditional edges are permitted only as predicates like
 * `confidence.overall >= 0.9` — never arbitrary code. That restriction is the
 * reason a graph can be reasoned about statically, so this evaluator is
 * deliberately tiny and has no escape hatch.
 */

import type { Artifact } from "./artifact.ts";

export class PredicateError extends Error {
  override name = "PredicateError";
}

const OPS = [">=", "<=", "==", "!=", ">", "<"] as const;
type Op = (typeof OPS)[number];

export interface Predicate {
  path: string;
  op: Op;
  value: number | string | boolean | null;
}

/** `confidence.overall >= 0.9` / `payload.acts.length > 2` / `labels.variant == "a"` */
export function parsePredicate(expr: string): Predicate {
  const trimmed = expr.trim();
  for (const op of OPS) {
    const at = trimmed.indexOf(op);
    if (at <= 0) continue;
    const path = trimmed.slice(0, at).trim();
    const rhs = trimmed.slice(at + op.length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(path)) {
      throw new PredicateError(`invalid field path "${path}" in predicate "${expr}"`);
    }
    return { path, op, value: parseLiteral(rhs, expr) };
  }
  throw new PredicateError(
    `predicate "${expr}" must be "<path> <op> <literal>" with op one of ${OPS.join(", ")}`,
  );
}

function parseLiteral(raw: string, expr: string): number | string | boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(raw);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  throw new PredicateError(`unsupported literal "${raw}" in predicate "${expr}"`);
}

/** Resolve a dotted path against the artifact envelope. `.length` is allowed. */
export function resolvePath(artifact: Artifact, path: string): unknown {
  let current: unknown = artifact;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (segment === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = current.length;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function evaluatePredicate(expr: string, artifact: Artifact): boolean {
  const { path, op, value } = parsePredicate(expr);
  const actual = resolvePath(artifact, path);

  // An unresolvable path is false, never a crash — a missing confidence should
  // route to a human, not abort the run.
  if (actual === undefined) return false;

  switch (op) {
    case "==":
      return actual === value;
    case "!=":
      return actual !== value;
    default:
      break;
  }
  if (typeof actual !== "number" || typeof value !== "number") {
    throw new PredicateError(
      `predicate "${expr}" compares non-numbers with "${op}" ` +
        `(${path} is ${typeof actual})`,
    );
  }
  switch (op) {
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case "<":
      return actual < value;
  }
}
