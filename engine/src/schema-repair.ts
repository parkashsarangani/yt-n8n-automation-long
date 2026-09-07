/**
 * Conservative structured-output repair helpers.
 *
 * The model occasionally emits schema-near JSON with fragment keys such as
 * `\":{` / `\"},{` or places a valid enclosing-object property one level too
 * deep. Those defects contain no semantic ambiguity: the schema itself tells us
 * the only legal destination. Repair them before enum normalization so a full
 * LLM retry is reserved for genuinely ambiguous output.
 */

// Last-resort enum values chosen to be inert rather than assertive.
const SAFE_FALLBACKS = ["none", "neutral", "idle", "auto", "static", "mechanism"];
const OMIT = Symbol("schema-repair-omit");

export interface EnumRepair {
  path: string;
  from: string;
  to: string;
}

export interface AdditionalPropertyRepair {
  path: string;
  key: string;
  action: "drop_syntax_fragment" | "move_to_enclosing_object" | "drop_unknown";
  target?: string;
}

interface ObjectFrame {
  schema: Record<string, unknown>;
  out: Record<string, unknown>;
  path: string;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
}

function looksLikeSyntaxFragment(key: string): boolean {
  // These characters are impossible in every current authored schema property
  // and match the concrete malformed keys observed from structured output.
  return /[{}[\]"',:]/.test(key);
}

/**
 * Repair only additional-property mistakes whose destination is unambiguous.
 * Required keys are never removed. Unknown keys are preserved when the schema
 * itself allows additional properties.
 */
export function repairAdditionalProperties(
  schema: unknown,
  data: unknown,
): { data: unknown; repairs: AdditionalPropertyRepair[] } {
  const repairs: AdditionalPropertyRepair[] = [];

  function walk(schemaNode: unknown, node: unknown, path: string, ancestors: ObjectFrame[]): unknown {
    if (!schemaNode || typeof schemaNode !== "object") return node;
    const s = schemaNode as Record<string, unknown>;

    if (Array.isArray(node) && s.items) {
      return node.map((item, i) => walk(s.items, item, `${path}[${i}]`, ancestors));
    }

    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const props = schemaProperties(s);
    if (Object.keys(props).length === 0) return node;

    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    const frame: ObjectFrame = { schema: s, out, path };
    const required = new Set(Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : []);

    for (const key of Object.keys(source)) {
      if (key in props) {
        out[key] = walk(props[key], source[key], `${path}.${key}`, [...ancestors, frame]);
        continue;
      }
      if (s.additionalProperties !== false || required.has(key)) continue;

      if (looksLikeSyntaxFragment(key)) {
        delete out[key];
        repairs.push({ path: `${path}.${key}`, key, action: "drop_syntax_fragment" });
        continue;
      }

      // Search nearest enclosing object first. This fixes the observed case
      // where `hero_role` was emitted inside `asset_brief`: the beat schema is
      // the first ancestor declaring that exact key, so there is one legal move.
      let moved = false;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i]!;
        const ancestorProps = schemaProperties(ancestor.schema);
        if (!(key in ancestorProps) || ancestor.out[key] !== undefined) continue;
        ancestor.out[key] = walk(ancestorProps[key], source[key], `${ancestor.path}.${key}`, ancestors.slice(0, i));
        delete out[key];
        repairs.push({
          path: `${path}.${key}`,
          key,
          action: "move_to_enclosing_object",
          target: `${ancestor.path}.${key}`,
        });
        moved = true;
        break;
      }
      if (moved) continue;

      delete out[key];
      repairs.push({ path: `${path}.${key}`, key, action: "drop_unknown" });
    }
    return out;
  }

  return { data: walk(schema, data, "$", []), repairs };
}

/**
 * Self-heal near-miss enum values before schema validation runs. The structural
 * repair above is intentionally executed first so an enum can be normalized in
 * its correct schema location after a misplaced-property move.
 */
export function repairEnumValues(schema: unknown, data: unknown): { data: unknown; repairs: EnumRepair[] } {
  const structural = repairAdditionalProperties(schema, data);
  const repairs: EnumRepair[] = structural.repairs.map((repair) => ({
    path: repair.path,
    from: repair.key,
    to: repair.action === "move_to_enclosing_object"
      ? `<moved to ${repair.target}>`
      : `<${repair.action}>`,
  }));
  const repaired = walk(schema, structural.data, "$", true);
  return { data: repaired, repairs };

  function walk(schemaNode: unknown, node: unknown, path: string, required: boolean): unknown {
    if (!schemaNode || typeof schemaNode !== "object") return node;
    const s = schemaNode as Record<string, unknown>;

    if (Array.isArray(s.enum) && typeof node === "string") {
      const allowed = s.enum.filter((v): v is string => typeof v === "string");
      if (allowed.length === 0 || allowed.includes(node)) return node;
      const normalized = node.trim().toLowerCase().replace(/[\s_]+/g, "-");
      const match = allowed.find((v) => v.toLowerCase() === normalized);
      if (match) {
        repairs.push({ path, from: node, to: match });
        return match;
      }
      if (node.trim() === "" && !required) {
        repairs.push({ path, from: node, to: "<omitted: optional, empty>" });
        return OMIT;
      }
      const fallback = allowed.find((v) => SAFE_FALLBACKS.includes(v)) ?? allowed[0];
      if (fallback !== undefined && fallback !== node) repairs.push({ path, from: node, to: fallback });
      return fallback ?? node;
    }

    if (node && typeof node === "object" && !Array.isArray(node) && s.properties && typeof s.properties === "object") {
      const props = s.properties as Record<string, unknown>;
      const requiredKeys = new Set(Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : []);
      const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
      for (const key of Object.keys(out)) {
        if (key in props) {
          const result = walk(props[key], out[key], `${path}.${key}`, requiredKeys.has(key));
          if (result === OMIT) delete out[key];
          else out[key] = result;
        }
      }
      return out;
    }

    if (Array.isArray(node) && s.items) {
      return node.map((item, i) => walk(s.items, item, `${path}[${i}]`, true));
    }

    return node;
  }
}
