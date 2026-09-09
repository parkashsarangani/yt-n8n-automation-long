/**
 * RFC 0010 semantic scenes — structured WHAT-must-be-visible data for
 * deterministic explanatory graphics. Rendering code owns geometry; the
 * Visual Director owns named entities, relationships and concise labels.
 */

export type SemanticSceneKind =
  | "scale_comparison"
  | "timeline"
  | "process"
  | "cause_chain"
  | "branching"
  | "comparison"
  | "before_after"
  | "relationship_graph"
  | "sequence"
  | "quantity"
  | "kinetic_phrase";

export const SEMANTIC_SCENE_KINDS: readonly SemanticSceneKind[] = Object.freeze([
  "scale_comparison",
  "timeline",
  "process",
  "cause_chain",
  "branching",
  "comparison",
  "before_after",
  "relationship_graph",
  "sequence",
  "quantity",
  "kinetic_phrase",
]);

export interface SemanticMarker {
  id: string;
  label: string;
  value: number;
  rate_label?: string;
  time_label?: string;
  retained?: boolean;
}

export interface SemanticAxis {
  label: string;
  unit: string;
  max: number;
}

export interface SemanticNode {
  id: string;
  label: string;
  sub_label?: string;
  retained?: boolean;
}

export interface SemanticEdge {
  from: string;
  to: string;
  label?: string;
  retained?: boolean;
}

export interface SemanticPhraseLine {
  text: string;
  emphasis: boolean;
}

/**
 * Flat authoring shape on purpose. Per-kind invariants live in
 * validateSemanticScene so structured-output models do not have to satisfy a
 * deeply nested oneOf union while still being held to a hard semantic contract.
 */
export interface SemanticScene {
  kind: SemanticSceneKind;
  sequence_id?: string;
  continuation?: boolean;
  caption: string;
  axis?: SemanticAxis;
  markers?: SemanticMarker[];
  equation?: string;
  nodes?: SemanticNode[];
  edges?: SemanticEdge[];
  steps?: SemanticNode[];
  before?: SemanticNode;
  after?: SemanticNode;
  items?: SemanticMarker[];
  lines?: SemanticPhraseLine[];
}

export const MAX_CAPTION_CHARS = 64;
export const MAX_PHRASE_LINE_CHARS = 28;
export const MAX_PHRASE_LINES = 3;
export const MAX_SEMANTIC_NODES = 7;
export const MAX_SEMANTIC_EDGES = 9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateNodes(scene: SemanticScene, beatId: string, min = 2): string[] {
  const errors: string[] = [];
  const nodes = scene.nodes;
  if (!Array.isArray(nodes) || nodes.length < min) {
    return [`${beatId}: ${scene.kind} requires at least ${min} labelled nodes`];
  }
  if (nodes.length > MAX_SEMANTIC_NODES) {
    errors.push(`${beatId}: ${scene.kind} has ${nodes.length} nodes > ${MAX_SEMANTIC_NODES}`);
  }
  const seen = new Set<string>();
  for (const node of nodes) {
    const id = trimmed(node?.id);
    if (!id) errors.push(`${beatId}: every node needs a stable id`);
    else if (seen.has(id)) errors.push(`${beatId}: duplicate node id '${id}'`);
    else seen.add(id);
    if (!trimmed(node?.label)) errors.push(`${beatId}: node '${id}' has no label`);
  }
  return errors;
}

function validateEdges(scene: SemanticScene, beatId: string, min = 1): string[] {
  const errors: string[] = [];
  const edges = scene.edges;
  if (!Array.isArray(edges) || edges.length < min) {
    return [`${beatId}: ${scene.kind} requires at least ${min} explicit relationship edge(s)`];
  }
  if (edges.length > MAX_SEMANTIC_EDGES) {
    errors.push(`${beatId}: ${scene.kind} has ${edges.length} edges > ${MAX_SEMANTIC_EDGES}`);
  }
  const ids = new Set((scene.nodes ?? []).map((node) => trimmed(node.id)).filter(Boolean));
  const pairs = new Set<string>();
  for (const edge of edges) {
    const from = trimmed(edge?.from);
    const to = trimmed(edge?.to);
    if (!from || !to) {
      errors.push(`${beatId}: every edge needs non-empty from/to ids`);
      continue;
    }
    if (from === to) errors.push(`${beatId}: edge '${from}->${to}' is a self-loop`);
    if (!ids.has(from)) errors.push(`${beatId}: edge source '${from}' is not a declared node`);
    if (!ids.has(to)) errors.push(`${beatId}: edge target '${to}' is not a declared node`);
    const pair = `${from}->${to}`;
    if (pairs.has(pair)) errors.push(`${beatId}: duplicate edge '${pair}'`);
    pairs.add(pair);
  }
  return errors;
}

export function validateSemanticScene(scene: SemanticScene, beatId = "scene"): string[] {
  const errors: string[] = [];
  if (!SEMANTIC_SCENE_KINDS.includes(scene.kind)) {
    return [`${beatId}: unknown semantic scene kind '${String(scene.kind)}'`];
  }
  const caption = trimmed(scene.caption);
  if (!caption) errors.push(`${beatId}: semantic scene caption is empty`);
  if (caption.length > MAX_CAPTION_CHARS) {
    errors.push(`${beatId}: caption is ${caption.length} chars > ${MAX_CAPTION_CHARS}; captions are phrases, not sentences`);
  }

  const markerErrors = (list: SemanticMarker[] | undefined, field: string, requireValue: boolean): SemanticMarker[] => {
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${beatId}: ${scene.kind} requires a non-empty ${field}`);
      return [];
    }
    const seen = new Set<string>();
    for (const marker of list) {
      const id = trimmed(marker?.id);
      if (!id) errors.push(`${beatId}: every ${field} entry needs a stable id`);
      else if (seen.has(id)) errors.push(`${beatId}: duplicate ${field} id '${id}'`);
      else seen.add(id);
      if (!trimmed(marker?.label)) errors.push(`${beatId}: ${field} '${id}' has no label`);
      if (requireValue && !isFiniteNumber(marker?.value)) errors.push(`${beatId}: ${field} '${id}' has no numeric value`);
    }
    return list;
  };

  const stepErrors = (list: SemanticNode[] | undefined, field: string): void => {
    if (!Array.isArray(list) || list.length < 2) {
      errors.push(`${beatId}: ${scene.kind} requires at least 2 ${field}`);
      return;
    }
    const seen = new Set<string>();
    for (const node of list) {
      const id = trimmed(node?.id);
      if (!id) errors.push(`${beatId}: every ${field} entry needs a stable id`);
      else if (seen.has(id)) errors.push(`${beatId}: duplicate ${field} id '${id}'`);
      else seen.add(id);
      if (!trimmed(node?.label)) errors.push(`${beatId}: ${field} '${id}' has no label`);
    }
  };

  switch (scene.kind) {
    case "scale_comparison": {
      const axis = scene.axis;
      if (!axis) errors.push(`${beatId}: scale_comparison requires an axis`);
      else {
        if (!trimmed(axis.label)) errors.push(`${beatId}: axis has no label`);
        if (!trimmed(axis.unit)) errors.push(`${beatId}: axis has no unit`);
        if (!isFiniteNumber(axis.max) || axis.max <= 0) errors.push(`${beatId}: axis.max must be a positive number`);
      }
      const markers = markerErrors(scene.markers, "markers", true);
      if (axis && isFiniteNumber(axis.max)) {
        for (const marker of markers) {
          if (isFiniteNumber(marker.value) && (marker.value < 0 || marker.value > axis.max)) {
            errors.push(`${beatId}: marker '${marker.id}' value ${marker.value} is outside the 0-${axis.max} axis`);
          }
        }
      }
      break;
    }
    case "timeline":
    case "sequence":
    case "comparison":
      errors.push(...validateNodes(scene, beatId, 2));
      if (scene.kind === "comparison" && (scene.nodes?.length ?? 0) > 3) {
        errors.push(`${beatId}: comparison supports at most 3 compared sides`);
      }
      break;
    case "process":
      stepErrors(scene.steps, "steps");
      break;
    case "cause_chain":
      errors.push(...validateNodes(scene, beatId, 2), ...validateEdges(scene, beatId, 1));
      break;
    case "branching": {
      errors.push(...validateNodes(scene, beatId, 3), ...validateEdges(scene, beatId, 2));
      const counts = new Map<string, number>();
      for (const edge of scene.edges ?? []) counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
      if (![...counts.values()].some((count) => count >= 2)) {
        errors.push(`${beatId}: branching requires one source node with at least two outgoing outcomes`);
      }
      break;
    }
    case "relationship_graph":
      errors.push(...validateNodes(scene, beatId, 2), ...validateEdges(scene, beatId, 1));
      break;
    case "before_after":
      if (!trimmed(scene.before?.label)) errors.push(`${beatId}: before_after requires a labelled 'before'`);
      if (!trimmed(scene.after?.label)) errors.push(`${beatId}: before_after requires a labelled 'after'`);
      break;
    case "quantity":
      markerErrors(scene.items, "items", true);
      break;
    case "kinetic_phrase": {
      const lines = scene.lines;
      if (!Array.isArray(lines) || lines.length === 0) {
        errors.push(`${beatId}: kinetic_phrase requires at least one line`);
        break;
      }
      if (lines.length > MAX_PHRASE_LINES) errors.push(`${beatId}: kinetic_phrase has ${lines.length} lines > ${MAX_PHRASE_LINES}`);
      for (const line of lines) {
        const text = trimmed(line?.text);
        if (!text) errors.push(`${beatId}: kinetic_phrase has an empty line`);
        if (text.length > MAX_PHRASE_LINE_CHARS) errors.push(`${beatId}: kinetic_phrase line is ${text.length} chars > ${MAX_PHRASE_LINE_CHARS}`);
      }
      if (lines.filter((line) => line?.emphasis === true).length !== 1) errors.push(`${beatId}: kinetic_phrase needs exactly one emphasis line`);
      break;
    }
  }
  return errors;
}

const FILLER_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","to","of","in","on","at","by","for","with","and","or","but","that","this","those","these","it","its","as","from","than","then","so","can","could","will","would","has","have","had","does","do","did","just","very","really","about",
]);

function squeeze(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (clean.length <= limit) return clean;
  const words = clean.split(" ");
  const kept: string[] = [];
  for (const word of words) {
    const candidate = [...kept, word].join(" ");
    if (candidate.length > limit) break;
    kept.push(word);
  }
  return kept.length ? kept.join(" ") : clean.slice(0, limit).trim();
}

const VALUE_PATTERN = /\b(\d[\d,.]*\s*(?:km\/h|kmph|mph|km|kilometers?|kilometres?|miles?|metres?|meters?|m|seconds?|s|minutes?|min|hours?|h|days?|years?|%|percent)|\d[\d,.]*)\b/gi;
const WORD_NUMBER_PATTERN = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion)\s+(kilometers?|kilometres?|km|miles?|hours?|minutes?|seconds?|days?|years?)\b/gi;

export function extractKineticPhrase(source: string): SemanticPhraseLine[] {
  const clean = source.replace(/\s+/g, " ").trim();
  if (!clean) return [{ text: "…", emphasis: true }];
  const values: string[] = [];
  for (const match of clean.matchAll(WORD_NUMBER_PATTERN)) values.push(match[0]!);
  for (const match of clean.matchAll(VALUE_PATTERN)) values.push(match[0]!);
  const headline = values.length
    ? squeeze(values[values.length - 1]!, MAX_PHRASE_LINE_CHARS)
    : squeeze(clean.split(" ").filter((word) => !FILLER_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ""))).slice(0, 3).join(" "), MAX_PHRASE_LINE_CHARS);
  const headIndex = clean.toLowerCase().indexOf(headline.toLowerCase());
  const lead = headIndex > 0 ? clean.slice(0, headIndex) : clean;
  const setup = squeeze(lead.split(" ").filter((word) => !FILLER_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ""))).join(" "), MAX_PHRASE_LINE_CHARS);
  const lines: SemanticPhraseLine[] = [];
  if (setup && setup.toLowerCase() !== headline.toLowerCase()) lines.push({ text: setup, emphasis: false });
  lines.push({ text: headline.toUpperCase(), emphasis: true });
  return lines.slice(0, MAX_PHRASE_LINES);
}

export function kineticPhraseScene(source: string, sequenceId?: string): SemanticScene {
  const lines = extractKineticPhrase(source);
  const emphasis = lines.find((line) => line.emphasis)?.text ?? lines[0]!.text;
  return { kind: "kinetic_phrase", caption: squeeze(emphasis, MAX_CAPTION_CHARS), lines, ...(sequenceId ? { sequence_id: sequenceId } : {}) };
}

export function semanticSceneRequirements(scene: SemanticScene): string[] {
  const out: string[] = [];
  if (scene.axis) out.push(`a labelled ${scene.axis.label} scale from 0 to ${scene.axis.max} ${scene.axis.unit}`);
  for (const marker of scene.markers ?? []) {
    const parts = [`a marker labelled "${marker.label}" at ${marker.value}${scene.axis ? ` ${scene.axis.unit}` : ""}`];
    if (marker.rate_label) parts.push(`showing "${marker.rate_label}"`);
    if (marker.time_label) parts.push(`showing "${marker.time_label}"`);
    out.push(parts.join(", "));
  }
  if (scene.equation) out.push(`the equation "${scene.equation}" written legibly`);
  for (const node of scene.nodes ?? []) out.push(`a ${scene.kind} node labelled "${node.label}"`);
  for (const edge of scene.edges ?? []) out.push(`a visible directed relationship from "${edge.from}" to "${edge.to}"${edge.label ? ` labelled "${edge.label}"` : ""}`);
  for (const step of scene.steps ?? []) out.push(`a process step labelled "${step.label}"`);
  if (scene.before) out.push(`a before state labelled "${scene.before.label}"`);
  if (scene.after) out.push(`an after state labelled "${scene.after.label}"`);
  for (const item of scene.items ?? []) out.push(`a bar labelled "${item.label}" sized for ${item.value}`);
  for (const line of scene.lines ?? []) out.push(`the text "${line.text}"`);
  return out;
}

/** Carry established semantic state across an explicitly shared sequence. */
export function threadSemanticSequence(scenes: SemanticScene[]): SemanticScene[] {
  interface SequenceState {
    axis?: SemanticAxis;
    markers: Map<string, SemanticMarker>;
    nodes: Map<string, SemanticNode>;
    steps: Map<string, SemanticNode>;
    edges: Map<string, SemanticEdge>;
  }
  const states = new Map<string, SequenceState>();
  return scenes.map((scene) => {
    const sequenceId = trimmed(scene.sequence_id);
    if (!sequenceId) return scene;
    let state = states.get(sequenceId);
    if (!state) {
      state = { markers: new Map(), nodes: new Map(), steps: new Map(), edges: new Map() };
      states.set(sequenceId, state);
    }
    const inheritedMarkers = [...state.markers.values()];
    const inheritedNodes = [...state.nodes.values()];
    const inheritedSteps = [...state.steps.values()];
    const inheritedEdges = [...state.edges.values()];
    const continues = scene.continuation === true || inheritedMarkers.length > 0 || inheritedNodes.length > 0 || inheritedSteps.length > 0 || inheritedEdges.length > 0;
    const ownMarkerIds = new Set((scene.markers ?? []).map((item) => trimmed(item.id)));
    const ownNodeIds = new Set((scene.nodes ?? []).map((item) => trimmed(item.id)));
    const ownStepIds = new Set((scene.steps ?? []).map((item) => trimmed(item.id)));
    const ownEdgeIds = new Set((scene.edges ?? []).map((edge) => `${trimmed(edge.from)}->${trimmed(edge.to)}`));
    const merged: SemanticScene = {
      ...scene,
      ...(continues ? { continuation: true } : {}),
      ...(scene.axis ?? state.axis ? { axis: scene.axis ?? state.axis! } : {}),
      ...(scene.markers || inheritedMarkers.length ? { markers: [...inheritedMarkers.filter((item) => !ownMarkerIds.has(item.id)).map((item) => ({ ...item, retained: true })), ...(scene.markers ?? [])] } : {}),
      ...(scene.nodes || inheritedNodes.length ? { nodes: [...inheritedNodes.filter((item) => !ownNodeIds.has(item.id)).map((item) => ({ ...item, retained: true })), ...(scene.nodes ?? [])] } : {}),
      ...(scene.steps || inheritedSteps.length ? { steps: [...inheritedSteps.filter((item) => !ownStepIds.has(item.id)).map((item) => ({ ...item, retained: true })), ...(scene.steps ?? [])] } : {}),
      ...(scene.edges || inheritedEdges.length ? { edges: [...inheritedEdges.filter((edge) => !ownEdgeIds.has(`${edge.from}->${edge.to}`)).map((edge) => ({ ...edge, retained: true })), ...(scene.edges ?? [])] } : {}),
    };
    if (merged.axis) state.axis = merged.axis;
    for (const marker of merged.markers ?? []) state.markers.set(marker.id, { ...marker, retained: true });
    for (const node of merged.nodes ?? []) state.nodes.set(node.id, { ...node, retained: true });
    for (const step of merged.steps ?? []) state.steps.set(step.id, { ...step, retained: true });
    for (const edge of merged.edges ?? []) state.edges.set(`${edge.from}->${edge.to}`, { ...edge, retained: true });
    return merged;
  });
}
