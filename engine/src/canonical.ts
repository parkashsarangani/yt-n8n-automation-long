/**
 * Canonical JSON serialization and content hashing.
 *
 * Implements RFC 8785 (JSON Canonicalization Scheme) plus one deliberate
 * extension: Unicode NFC normalization of all strings and object keys, as
 * required by RFC 0007. Strict JCS leaves literal strings un-normalized; we
 * normalize so that two payloads that render identically hash identically.
 *
 * This file underpins artifact identity (RFC 0002). A change to its output is
 * a change to every artifact id in existence, so it MUST NOT be modified
 * without a migration plan.
 */

import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

/**
 * Serialize a JSON value to its canonical form.
 *
 * Rules (beyond plain JSON):
 * - Object keys are sorted by UTF-16 code unit, after NFC normalization.
 * - No insignificant whitespace.
 * - Numbers use ECMAScript Number::toString (so -0 serializes as "0").
 * - Strings use the shortest legal JSON escaping.
 *
 * Value handling, chosen so that nothing can silently change a hash:
 * - `undefined` as an object value is DROPPED (matches JSON.stringify, and is
 *   the idiomatic "optional field absent" case — lossless on round-trip).
 * - `undefined`, functions, and symbols inside ARRAYS throw. JSON.stringify
 *   would substitute `null`, which would silently alter meaning.
 * - NaN, Infinity, BigInt, functions, symbols, and cycles throw.
 * - `toJSON()` is honoured, as in JSON.stringify (so Date -> ISO string).
 */
export function canonicalize(value: unknown): string {
  return write(value, new Set(), "$");
}

/** sha256 of the canonical form, as a lowercase hex string. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function write(value: unknown, seen: Set<object>, path: string): string {
  const v = unwrapToJSON(value, path);

  if (v === null) return "null";

  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";

    case "number":
      if (!Number.isFinite(v)) {
        throw new CanonicalizationError(`non-finite number at ${path}: ${String(v)}`);
      }
      // ECMAScript Number::toString is exactly what JCS specifies, and is what
      // JSON.stringify emits (including "0" for -0 and "1e+21" for 1e21).
      return JSON.stringify(v)!;

    case "string":
      // JSON.stringify produces JCS-conformant escaping: short forms for
      // \b \t \n \f \r, \u00xx for other C0 controls, and only " and \ escaped.
      return JSON.stringify(v.normalize("NFC"));

    case "bigint":
      throw new CanonicalizationError(
        `bigint is not JSON-representable at ${path}; convert to number or string first`,
      );

    case "function":
    case "symbol":
    case "undefined":
      // Reachable only from an array element or the root; object properties are
      // filtered before recursion.
      throw new CanonicalizationError(`${typeof v} is not JSON-representable at ${path}`);

    case "object":
      break;

    default:
      throw new CanonicalizationError(`unsupported value at ${path}`);
  }

  const obj = v as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError(`circular reference at ${path}`);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((el, i) => write(el, seen, `${path}[${i}]`));
      return `[${parts.join(",")}]`;
    }
    return writeObject(obj as Record<string, unknown>, seen, path);
  } finally {
    seen.delete(obj);
  }
}

function writeObject(obj: Record<string, unknown>, seen: Set<object>, path: string): string {
  // Normalize keys first so that NFC-equivalent keys are detected as the
  // collision they are, rather than one silently overwriting the other.
  const entries: Array<[string, unknown]> = [];
  const byNormalized = new Map<string, string>();

  for (const rawKey of Object.keys(obj)) {
    const value = obj[rawKey];
    if (value === undefined) continue; // absent optional field

    const key = rawKey.normalize("NFC");
    const prior = byNormalized.get(key);
    if (prior !== undefined) {
      throw new CanonicalizationError(
        `keys ${JSON.stringify(prior)} and ${JSON.stringify(rawKey)} at ${path} ` +
          `collide after NFC normalization`,
      );
    }
    byNormalized.set(key, rawKey);
    entries.push([key, value]);
  }

  // JCS orders by UTF-16 code unit. Explicit comparator rather than the default
  // sort, so the intent survives future edits.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const parts = entries.map(
    ([key, value]) => `${JSON.stringify(key)}:${write(value, seen, `${path}.${key}`)}`,
  );
  return `{${parts.join(",")}}`;
}

/** Honour toJSON() the way JSON.stringify does (Date, and anything custom). */
function unwrapToJSON(value: unknown, path: string): unknown {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "bigint") &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    const out = (value as { toJSON: (key?: string) => unknown }).toJSON();
    if (out !== null && typeof out === "object" && typeof (out as { toJSON?: unknown }).toJSON === "function") {
      throw new CanonicalizationError(`toJSON() returned another toJSON-able value at ${path}`);
    }
    return out;
  }
  return value;
}
