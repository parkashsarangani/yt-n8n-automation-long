/**
 * Self-heals near-miss enum values before schema validation runs.
 *
 * Large structured-output payloads (e.g. a 24-scene visual_plan with a dozen
 * enum-typed fields per scene) have enough surface area that a capable model
 * occasionally emits one field slightly off-vocabulary (wrong case, a
 * synonym, stray whitespace) even when the prompt and schema agree on the
 * vocabulary. Historically that single field failed the whole payload and
 * burned a full retry attempt. This walks the payload against its own schema
 * (never a hardcoded copy of the enum lists, so it can't drift from them) and
 * snaps recoverable near-misses to the closest valid value, falling back to a
 * neutral default only when no case/whitespace/hyphen match exists.
 */

const SAFE_FALLBACKS = ["none", "neutral", "idle", "auto", "static"];

export interface EnumRepair {
  path: string;
  from: string;
  to: string;
}

export function repairEnumValues(schema: unknown, data: unknown): { data: unknown; repairs: EnumRepair[] } {
  const repairs: EnumRepair[] = [];
  const repaired = walk(schema, data, "$");
  return { data: repaired, repairs };

  function walk(schemaNode: unknown, node: unknown, path: string): unknown {
    if (!schemaNode || typeof schemaNode !== "object") return node;
    const s = schemaNode as Record<string, unknown>;

    if (Array.isArray(s.enum) && typeof node === "string") {
      const allowed = s.enum.filter((v): v is string => typeof v === "string");
      if (allowed.length === 0 || allowed.includes(node)) return node;
      const normalized = node.trim().toLowerCase().replace(/[\s_]+/g, "-");
      const match = allowed.find((v) => v.toLowerCase() === normalized);
      const fallback = allowed.find((v) => SAFE_FALLBACKS.includes(v)) ?? allowed[0];
      const to = match ?? fallback;
      if (to !== undefined && to !== node) repairs.push({ path, from: node, to });
      return to ?? node;
    }

    if (node && typeof node === "object" && !Array.isArray(node) && s.properties && typeof s.properties === "object") {
      const props = s.properties as Record<string, unknown>;
      const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
      for (const key of Object.keys(out)) {
        if (key in props) out[key] = walk(props[key], out[key], `${path}.${key}`);
      }
      return out;
    }

    if (Array.isArray(node) && s.items) {
      return node.map((item, i) => walk(s.items, item, `${path}[${i}]`));
    }

    return node;
  }
}
