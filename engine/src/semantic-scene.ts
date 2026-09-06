/**
 * RFC 0010 semantic scenes — the structured "WHAT must be visible" for a
 * deterministic explanatory graphic.
 *
 * The previous motion-graphic path handed the renderer a prose brief plus a
 * bag of `{kind:"concept"}` entities, and the renderer answered with the same
 * abstract rectangles for every beat: a rendered benchmark scored those beats
 * 0.05-0.28 semantic match and 0.60 generic filler, because "two boxes and a
 * caption" genuinely is reusable for any sentence. Prose brief -> generic
 * geometry is not a representation; it is decoration that happens to be
 * timed to narration.
 *
 * A SemanticScene is instead a small set of *named quantities and relations*
 * that a renderer must draw literally: an axis with a unit and a maximum,
 * markers carrying their own value/rate/elapsed labels, an equation, ordered
 * timeline nodes, process steps. If a beat cannot be described this way it is
 * not a semantic graphic and must fall back to kinetic text (`kinetic_phrase`)
 * rather than being smeared into a diagram-shaped placeholder.
 *
 * This module is pure: types, validation, sequence-state threading and phrase
 * extraction. It performs no rendering and no I/O, so every rule here is
 * covered by fast deterministic tests rather than by a 30-minute live render.
 */

export type SemanticSceneKind =
  | "scale_comparison"
  | "timeline"
  | "process"
  | "before_after"
  | "quantity"
  | "kinetic_phrase";

export const SEMANTIC_SCENE_KINDS: readonly SemanticSceneKind[] = Object.freeze([
  "scale_comparison",
  "timeline",
  "process",
  "before_after",
  "quantity",
  "kinetic_phrase",
]);

/** A single labelled thing the viewer must actually see on the graphic. */
export interface SemanticMarker {
  /** Stable within a sequence, so a later beat can retain/extend this marker. */
  id: string;
  /** Short display name, e.g. "Walking". Not a sentence. */
  label: string;
  /** Position on the scene's axis, in the axis unit. */
  value: number;
  /** e.g. "5 km/h" — the rate that produced `value`, drawn beside the marker. */
  rate_label?: string;
  /** e.g. "4 hours" — elapsed time at `value`, drawn at the marker's endpoint. */
  time_label?: string;
  /** Established by an earlier beat of the same sequence; drawn already-complete. */
  retained?: boolean;
}

export interface SemanticAxis {
  /** e.g. "distance". */
  label: string;
  /** e.g. "km". */
  unit: string;
  /** Axis maximum in `unit`; the origin is always 0. */
  max: number;
}

export interface SemanticNode {
  id: string;
  label: string;
  sub_label?: string;
  retained?: boolean;
}

export interface SemanticPhraseLine {
  text: string;
  /** Exactly one line in a kinetic phrase is the emphasised value/keyword. */
  emphasis: boolean;
}

/**
 * Flat rather than a discriminated union on purpose: the Visual Director
 * authors this as JSON against a draft-2020-12 schema, and per-`kind` `oneOf`
 * branches with `additionalProperties:false` are exactly the shape LLMs fail
 * to satisfy most often. `kind` selects which fields are required; the
 * unrelated ones are simply absent. `validateSemanticScene` is the real
 * contract.
 */
export interface SemanticScene {
  kind: SemanticSceneKind;
  /**
   * Beats sharing a sequence id render as ONE evolving composition rather than
   * three independent resets. Threading is done by `threadSemanticSequence`.
   */
  sequence_id?: string;
  /** True when this beat continues an already-established sequence scene. */
  continuation?: boolean;
  /** Short on-screen phrase. Never the full viewer_takeaway sentence. */
  caption: string;
  axis?: SemanticAxis;
  markers?: SemanticMarker[];
  /** e.g. "5 × 4 = 20 km" — drawn large and legible when present. */
  equation?: string;
  nodes?: SemanticNode[];
  steps?: SemanticNode[];
  before?: SemanticNode;
  after?: SemanticNode;
  items?: SemanticMarker[];
  lines?: SemanticPhraseLine[];
}

/** Hard cap so a caption can never become the paragraph-length overflow the
 * rendered benchmark showed clipping off both frame edges. */
export const MAX_CAPTION_CHARS = 64;
/** Kinetic text is read at a glance; a line longer than this cannot be set at
 * an emphatic size inside the 1920px safe area. */
export const MAX_PHRASE_LINE_CHARS = 28;
export const MAX_PHRASE_LINES = 3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Structural validation. Returns human-readable errors; an empty array means
 * the scene can be drawn literally.
 *
 * The point of every rule here is the same: refuse a scene that would render
 * as anonymous geometry. A `scale_comparison` without an axis unit, or with
 * markers that carry no value, is precisely the "abstract boxes" failure —
 * so it is rejected at the contract, not discovered in the rendered pixels.
 */
export function validateSemanticScene(scene: SemanticScene, beatId = "scene"): string[] {
  const errors: string[] = [];
  if (!SEMANTIC_SCENE_KINDS.includes(scene.kind)) {
    errors.push(`${beatId}: unknown semantic scene kind '${String(scene.kind)}'`);
    return errors;
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
      if (requireValue && !isFiniteNumber(marker?.value)) {
        errors.push(`${beatId}: ${field} '${id}' has no numeric value; an unvalued marker draws as an anonymous shape`);
      }
    }
    return list;
  };

  const nodeErrors = (list: SemanticNode[] | undefined, field: string): void => {
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
      if (!axis) {
        errors.push(`${beatId}: scale_comparison requires an axis`);
      } else {
        if (!trimmed(axis.label)) errors.push(`${beatId}: axis has no label`);
        if (!trimmed(axis.unit)) errors.push(`${beatId}: axis has no unit; an unlabelled scale is not a scale`);
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
      nodeErrors(scene.nodes, "nodes");
      break;
    case "process":
      nodeErrors(scene.steps, "steps");
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
      if (lines.length > MAX_PHRASE_LINES) {
        errors.push(`${beatId}: kinetic_phrase has ${lines.length} lines > ${MAX_PHRASE_LINES}`);
      }
      for (const line of lines) {
        const text = trimmed(line?.text);
        if (!text) errors.push(`${beatId}: kinetic_phrase has an empty line`);
        if (text.length > MAX_PHRASE_LINE_CHARS) {
          errors.push(`${beatId}: kinetic_phrase line '${text.slice(0, 24)}…' is ${text.length} chars > ${MAX_PHRASE_LINE_CHARS}`);
        }
      }
      if (lines.filter((line) => line?.emphasis === true).length !== 1) {
        errors.push(`${beatId}: kinetic_phrase needs exactly one emphasis line`);
      }
      break;
    }
  }
  return errors;
}

const FILLER_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","to","of","in","on","at","by","for",
  "with","and","or","but","that","this","those","these","it","its","as","from","than","then","so",
  "can","could","will","would","has","have","had","does","do","did","just","very","really","about",
]);

/** Title-case-ish emphasis for a short keyword line without shouting acronyms. */
function emphasise(text: string): string {
  return text.toUpperCase();
}

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
  if (kept.length === 0) return clean.slice(0, limit).trim();
  return kept.join(" ");
}

/**
 * Numbers with their units, in narration order: "5 km/h", "20 kilometers",
 * "four hours". These are what a viewer actually needs to see, and the
 * rendered benchmark showed the old renderer dropping every one of them.
 */
const VALUE_PATTERN =
  /\b(\d[\d,.]*\s*(?:km\/h|kmph|mph|km|kilometers?|kilometres?|miles?|metres?|meters?|m|seconds?|s|minutes?|min|hours?|h|days?|years?|%|percent)|\d[\d,.]*)\b/gi;

const WORD_NUMBER_PATTERN =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion)\s+(kilometers?|kilometres?|km|miles?|hours?|minutes?|seconds?|days?|years?)\b/gi;

/**
 * Derive a short, emphatic kinetic phrase from a narration/takeaway sentence.
 *
 * The rendered benchmark put "Walking at five kilometers an hour covers twenty
 * kilometers in four hours." on screen as one non-wrapping line and clipped it
 * off both frame edges. A kinetic-text fallback has to *choose* what to show:
 * a short setup line, one emphasised value, and at most one closing line.
 *
 * This is deliberately deterministic (no model call): it is a fallback path
 * that must work when everything else is failing.
 */
export function extractKineticPhrase(source: string): SemanticPhraseLine[] {
  const clean = source.replace(/\s+/g, " ").trim();
  if (!clean) return [{ text: "…", emphasis: true }];

  const values: string[] = [];
  for (const match of clean.matchAll(WORD_NUMBER_PATTERN)) values.push(match[0]!);
  for (const match of clean.matchAll(VALUE_PATTERN)) values.push(match[0]!);

  const headline = values.length
    ? squeeze(values[values.length - 1]!, MAX_PHRASE_LINE_CHARS)
    : squeeze(
      clean
        .split(" ")
        .filter((word) => !FILLER_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, "")))
        .slice(0, 3)
        .join(" "),
      MAX_PHRASE_LINE_CHARS,
    );

  // The setup line is the words leading up to the emphasised value, trimmed to
  // something readable at a glance rather than the whole clause.
  const headIndex = clean.toLowerCase().indexOf(headline.toLowerCase());
  const lead = headIndex > 0 ? clean.slice(0, headIndex) : clean;
  const setup = squeeze(
    lead
      .split(" ")
      .filter((word) => !FILLER_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, "")))
      .join(" "),
    MAX_PHRASE_LINE_CHARS,
  );

  const lines: SemanticPhraseLine[] = [];
  if (setup && setup.toLowerCase() !== headline.toLowerCase()) {
    lines.push({ text: setup, emphasis: false });
  }
  lines.push({ text: emphasise(headline), emphasis: true });
  return lines.slice(0, MAX_PHRASE_LINES);
}

/** A kinetic-phrase scene built from whatever copy the beat actually has. */
export function kineticPhraseScene(source: string, sequenceId?: string): SemanticScene {
  const lines = extractKineticPhrase(source);
  const emphasisLine = lines.find((line) => line.emphasis)?.text ?? lines[0]!.text;
  return {
    kind: "kinetic_phrase",
    caption: squeeze(emphasisLine, MAX_CAPTION_CHARS),
    lines,
    ...(sequenceId ? { sequence_id: sequenceId } : {}),
  };
}

/**
 * Carry an explanatory sequence's established state into its continuation
 * beats.
 *
 * Beats 6-8 of the rendered benchmark ("put the speeds on one scale" ->
 * "walking covers 20 km in four hours" -> "a message covers it in a fraction
 * of a second") are one cumulative explanation, and rendering them as three
 * independent scenes is both why they looked identical to each other and why
 * the message never visibly crossed the *same* scale the walker did.
 *
 * Given the scenes in timeline order, a continuation scene inherits the axis
 * and every marker/node established earlier in its sequence. Inherited entries
 * are flagged `retained:true` so the renderer draws them already-complete
 * instead of re-animating them from zero, and the beat's own entries stay
 * un-retained so its new information is what moves.
 */
export function threadSemanticSequence(scenes: SemanticScene[]): SemanticScene[] {
  interface SequenceState {
    axis?: SemanticAxis;
    markers: Map<string, SemanticMarker>;
    nodes: Map<string, SemanticNode>;
    steps: Map<string, SemanticNode>;
  }
  const states = new Map<string, SequenceState>();

  return scenes.map((scene) => {
    const sequenceId = trimmed(scene.sequence_id);
    if (!sequenceId) return scene;
    let state = states.get(sequenceId);
    if (!state) {
      state = { markers: new Map(), nodes: new Map(), steps: new Map() };
      states.set(sequenceId, state);
    }

    const inheritedMarkers = [...state.markers.values()];
    const inheritedNodes = [...state.nodes.values()];
    const inheritedSteps = [...state.steps.values()];
    // A beat that declares `continuation` inherits; the first beat of a
    // sequence establishes. A beat that forgot the flag but arrives after the
    // sequence already has state is treated as a continuation anyway -- losing
    // the shared scale is a worse failure than an over-eager retain.
    const continues = scene.continuation === true || inheritedMarkers.length > 0 || inheritedNodes.length > 0 || inheritedSteps.length > 0;

    const ownMarkerIds = new Set((scene.markers ?? []).map((marker) => trimmed(marker.id)));
    const ownNodeIds = new Set((scene.nodes ?? []).map((node) => trimmed(node.id)));
    const ownStepIds = new Set((scene.steps ?? []).map((step) => trimmed(step.id)));

    const merged: SemanticScene = {
      ...scene,
      ...(continues ? { continuation: true } : {}),
      ...(scene.axis ?? state.axis ? { axis: scene.axis ?? state.axis! } : {}),
      ...(scene.markers || inheritedMarkers.length
        ? {
          markers: [
            ...inheritedMarkers
              .filter((marker) => !ownMarkerIds.has(marker.id))
              .map((marker) => ({ ...marker, retained: true })),
            ...(scene.markers ?? []),
          ],
        }
        : {}),
      ...(scene.nodes || inheritedNodes.length
        ? {
          nodes: [
            ...inheritedNodes.filter((node) => !ownNodeIds.has(node.id)).map((node) => ({ ...node, retained: true })),
            ...(scene.nodes ?? []),
          ],
        }
        : {}),
      ...(scene.steps || inheritedSteps.length
        ? {
          steps: [
            ...inheritedSteps.filter((step) => !ownStepIds.has(step.id)).map((step) => ({ ...step, retained: true })),
            ...(scene.steps ?? []),
          ],
        }
        : {}),
    };

    // Persist this beat's contribution for the next beat of the sequence. The
    // axis is sticky: a continuation that omits it keeps drawing the same one.
    if (merged.axis) state.axis = merged.axis;
    for (const marker of merged.markers ?? []) state.markers.set(marker.id, { ...marker, retained: true });
    for (const node of merged.nodes ?? []) state.nodes.set(node.id, { ...node, retained: true });
    for (const step of merged.steps ?? []) state.steps.set(step.id, { ...step, retained: true });

    return merged;
  });
}
