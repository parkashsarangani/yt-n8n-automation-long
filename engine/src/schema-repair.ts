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

// Last-resort values chosen to be inert rather than assertive. "mechanism"
// earns a place for the renderer's visual_state: that enum begins with
// "hypothesis", so an off-vocabulary state -- the planner reaching for a script
// beat name like "correction" -- fell through to allowed[0] and drew the scene
// as a tentative dashed guess. That is the opposite of what a correction beat
// means, and nothing surfaced it because the repair succeeded. "mechanism" is
// the plain explanatory state, which is the safe thing to draw when the
// intended one cannot be recovered.
const SAFE_FALLBACKS = ["none", "neutral", "idle", "auto", "static", "mechanism"];

// Sentinel returned by walk() to mean "drop this key" rather than "here is a
// repaired value for it". Only ever produced for an optional field.
const OMIT = Symbol("schema-repair-omit");

export interface EnumRepair {
  path: string;
  from: string;
  to: string;
}

export function repairEnumValues(schema: unknown, data: unknown): { data: unknown; repairs: EnumRepair[] } {
  const repairs: EnumRepair[] = [];
  const repaired = walk(schema, data, "$", true);
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
      // No case/whitespace/hyphen near-miss. An empty string on an OPTIONAL
      // enum field is a distinct signal from a garbled real value: many
      // structured-output layers fill every declared property even when a
      // field only applies conditionally (e.g. hero_role only means
      // something when importance === "hero"), padding the unused ones with
      // "". Snapping that to allowed[0] used to invent a value the model
      // never intended and that a downstream invariant may forbid outright
      // (a non-hero shot must not carry a hero_role at all) -- so drop the
      // key instead of guessing. A required field can't be dropped without
      // failing validation anyway, so it keeps the fallback-guess behavior.
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
