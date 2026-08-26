import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";

const LONG_CARTOON_PLAN_SCENES = 13;
const SHORT_DIALOGUE_WORD_LIMIT = 10;
const HUMAN_MOMENT_MIN_RATIO = 0.45;
// Must match cartoon-scenes.ts's WORDS_PER_SECOND/LONG_SCRIPT_SECONDS --
// duplicated here so the final-scene-payoff/midpoint checks can run at the
// writer stage (with retry-and-feedback) instead of only at the downstream
// compiler worker stage (no retry: a script that reaches the compiler with a
// dangling non-payoff ending blocks the run permanently, since resuming just
// re-validates the same stored script against the same deterministic check).
const WORDS_PER_SECOND = 2.6;
const LONG_SCRIPT_SECONDS = 75;

interface ScriptScene {
  scene_index: number;
  narration?: string;
  point?: string;
  is_outro?: boolean;
}

interface PlanScene {
  scene_index: number;
  background_location?: string;
  background_variant?: string;
  framing?: string;
  camera_motion?: string;
  visual_event?: string;
  ambient_motion?: string;
  primary_prop?: string;
  prop_state?: string;
  prop_motion?: string;
  foreground_action?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scenesFromPayload(payload: unknown): ScriptScene[] {
  const scenes = asRecord(payload)?.scenes;
  return Array.isArray(scenes) ? scenes as ScriptScene[] : [];
}

function inputScriptScenes(inputs: Record<string, Artifact>): ScriptScene[] {
  return scenesFromPayload(inputs["script"]?.payload);
}

function planScenes(payload: unknown): PlanScene[] {
  const scenes = asRecord(payload)?.scenes;
  return Array.isArray(scenes) ? scenes as PlanScene[] : [];
}

function wordCount(value: unknown): number {
  return typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean).length : 0;
}

function normalizeLine(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter((token) => token.length > 2));
}

function jaccard(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / (left.size + right.size - overlap);
}

function backgroundKey(scene: PlanScene | undefined): string {
  if (!scene) return "";
  const location = typeof scene.background_location === "string" ? scene.background_location : "";
  const variant = typeof scene.background_variant === "string" ? scene.background_variant : "";
  return location && variant ? `${location}/${variant}` : "";
}

const HUMAN_MOMENT_PATTERN = /\b(?:i|i'm|im|i’ll|i'd|me|my|you|you're|youre|your|we|we're|were|wait|nope|ugh|okay|still|again|late|where|why|how|fine|hate|rude|keys?)\b|(?:n't|'m|'re|'ve|'ll|'d)/i;
const DEFINITIONAL_DIALOGUE_PATTERN = /\b(?:this means|the reason is|in other words|research shows|studies show|is called|it's called|it is called|by that,\s*(?:it's|it is)\s+called|actually tested this|that is fascinating|that's fascinating|interesting)\b/i;
const TRAILING_ELLIPSIS_PATTERN = /\.\.\.\s*$/;

function normalizedProp(value: string): string {
  const cleaned = value
    .replace(/\b(?:the|a|an|central|object|prop|this|that|my|your|his|her|their|our|its)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const canonicalizers: Array<[RegExp, string]> = [
    [/\b(?:phone|screen|app|notification|message|text|lock\s*screen)\b/, "phone"],
    [/\b(?:charger|charging cable|cable)\b/, "charger"],
    [/\b(?:window)\b/, "window"],
    [/\b(?:clock|timer|alarm|watch|countdown|time)\b/, "clock"],
    [/\b(?:keys?|keyring)\b/, "keys"],
    [/\b(?:calendar|schedule|planner|plan|estimate|buffer)\b/, "calendar"],
    [/\b(?:route\s*map|map|route|traffic|gps)\b/, "route-map"],
    [/\b(?:door|doorway|front\s+door)\b/, "door"],
    [/\b(?:coffee|cup|mug)\b/, "coffee"],
    [/\b(?:shoes?|sneakers?|boots?)\b/, "shoes"],
    [/\b(?:kettle|tea\s+kettle)\b/, "kettle"],
    [/\b(?:bill|invoice|receipt|statement)\b/, "bill"],
    [/\b(?:letter|envelope|mail)\b/, "letter"],
    [/\b(?:tool|hammer|wrench|screwdriver|drill)\b/, "tool"],
    [/\b(?:vehicle|car|bus|train|bike|bicycle|scooter|airplane|plane)\b/, "vehicle"],
    [/\b(?:food|meal|snack|banana|sandwich|pizza|cake|soup|tea)\b/, "food"],
    [/\b(?:microwave|oven|fridge|refrigerator|washing\s*machine)\b/, "appliance"],
    [/\b(?:book|notebook|paper|document|form)\b/, "document"],
    [/\b(?:locker|cabinet|box)\b/, "locker"],
  ];
  for (const [pattern, canonical] of canonicalizers) if (pattern.test(cleaned)) return canonical;
  return cleaned.split(/[,/]/)[0]?.trim() ?? "";
}

function pointField(scene: ScriptScene, keys: string[]): string {
  const point = scene.point ?? "";
  for (const key of keys) {
    const match = new RegExp(`(?:^|[;|])\\s*${key}\\s*[:=]\\s*([^;|]+)`, "i").exec(point);
    if (match?.[1]) return match[1].replace(/\s+/g, " ").trim().toLowerCase();
  }
  return "";
}

function propValue(scene: ScriptScene): string {
  return normalizedProp(pointField(scene, ["prop", "central_object", "prop_in_scene", "object"]));
}

function allSceneText(scenes: ScriptScene[]): string {
  return scenes.map((scene) => `${scene.narration ?? ""} ${scene.point ?? ""}`).join("\n").toLowerCase();
}

function isPlanningOrLatenessTopic(scenes: ScriptScene[]): boolean {
  return /\b(?:late|lateness|leaving early|leave early|planning fallacy|schedule|estimate|buffer|clock|timer|keys?|traffic|route|calendar|morning|spare|door)\b/.test(allSceneText(scenes));
}

function isDoorwayOrSpatialTopic(scenes: ScriptScene[]): boolean {
  return /\b(?:doorway|new room|old room|walked into|walk into|crossing|through the door|room changed|room switch|location updating|go back|came back)\b/.test(allSceneText(scenes));
}

function repeatedPhraseFailure(scene: ScriptScene): string | null {
  const phrases = (scene.narration ?? "")
    .split(/[.!?;,]+/)
    .map((part) => part.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  const counts = new Map<string, number>();
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i]!;
    if (phrase === phrases[i - 1] && wordCount(phrase) <= 3) return `scene ${scene.scene_index} repeats "${phrase}" consecutively`;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    if ((counts.get(phrase) ?? 0) >= 3 && wordCount(phrase) <= 4) return `scene ${scene.scene_index} repeats "${phrase}" three times in one line`;
  }
  return null;
}

function duplicateDialogueFailures(scenes: ScriptScene[]): string[] {
  const failures: string[] = [];
  const seen = new Map<string, number>();
  const normalizedLines = scenes.map((scene) => ({ scene, line: normalizeLine(scene.narration) })).filter(({ line }) => line.length > 0);

  for (const { scene, line } of normalizedLines) {
    const previous = seen.get(line);
    if (previous !== undefined && wordCount(line) >= 4) failures.push(`scene ${scene.scene_index} exactly repeats scene ${previous}: "${scene.narration}"`);
    if (previous === undefined) seen.set(line, scene.scene_index);
  }

  for (let i = 0; i < normalizedLines.length; i++) {
    for (let j = i + 1; j < Math.min(normalizedLines.length, i + 6); j++) {
      const a = normalizedLines[i]!;
      const b = normalizedLines[j]!;
      if (wordCount(a.line) >= 5 && wordCount(b.line) >= 5 && a.line !== b.line && jaccard(a.line, b.line) >= 0.82) {
        failures.push(`scene ${b.scene.scene_index} nearly repeats scene ${a.scene.scene_index}`);
      }
    }
  }

  const openings = new Map<string, number[]>();
  for (const { scene, line } of normalizedLines) {
    const opening = line.split(/\s+/).slice(0, 3).join(" ");
    if (wordCount(opening) < 3) continue;
    openings.set(opening, [...(openings.get(opening) ?? []), scene.scene_index]);
  }
  for (const [opening, indexes] of openings) if (indexes.length >= 3) failures.push(`opening phrase "${opening}" repeats in scenes ${indexes.join(", ")}`);
  return failures.slice(0, 8);
}

function roboticDialogueFailures(scenes: ScriptScene[]): string[] {
  const failures: string[] = [];
  for (const scene of scenes) {
    const narration = scene.narration ?? "";
    const repeated = repeatedPhraseFailure(scene);
    if (repeated) failures.push(repeated);
    if (TRAILING_ELLIPSIS_PATTERN.test(narration)) failures.push(`scene ${scene.scene_index} ends with unresolved ellipsis`);
    if (DEFINITIONAL_DIALOGUE_PATTERN.test(narration)) failures.push(`scene ${scene.scene_index} uses definition/explainer phrasing`);
  }
  return failures;
}

function validateDialogueScript(payload: unknown, def: AgentDef): string[] {
  const contentScenes = scenesFromPayload(payload).filter((scene) => !scene.is_outro).sort((a, b) => a.scene_index - b.scene_index);
  if (contentScenes.length === 0) return [];
  const errors: string[] = [];
  const failures: string[] = [];

  const shortLineCount = contentScenes.filter((scene) => wordCount(scene.narration) <= SHORT_DIALOGUE_WORD_LIMIT).length;
  const requiredShortLines = Math.ceil(contentScenes.length / 2);
  if (shortLineCount < requiredShortLines) failures.push(`${shortLineCount}/${contentScenes.length} lines are ${SHORT_DIALOGUE_WORD_LIMIT} words or fewer; at least half (${requiredShortLines}/${contentScenes.length}) must be short`);

  const humanMomentCount = contentScenes.filter((scene) => HUMAN_MOMENT_PATTERN.test(scene.narration ?? "")).length;
  const requiredHumanMomentLines = Math.ceil(contentScenes.length * HUMAN_MOMENT_MIN_RATIO);
  if (humanMomentCount < requiredHumanMomentLines) failures.push(`${humanMomentCount}/${contentScenes.length} lines sound like someone inside the situation; at least ${requiredHumanMomentLines}/${contentScenes.length} are required`);

  const roboticFailures = [...roboticDialogueFailures(contentScenes), ...duplicateDialogueFailures(contentScenes)];
  if (roboticFailures.length > 0) failures.push(`robotic or duplicate dialogue patterns: ${roboticFailures.slice(0, 8).join("; ")}. Rewrite with ordinary spoken responses, complete thoughts, no repeated captions, and no repeated incantations.`);

  if (failures.length > 0) errors.push(`${def.name}@${def.version ?? "1"} natural dialogue gate failed: ${failures.join("; ")}. Rewrite as short, human, situational dialogue, not textbook/explainer speech.`);

  if (isPlanningOrLatenessTopic(contentScenes)) {
    const phoneScenes = contentScenes.filter((scene) => propValue(scene) === "phone");
    if (phoneScenes.length > 0) errors.push(`${def.name}@${def.version ?? "1"} topic prop gate failed: planning/lateness scenes ${phoneScenes.map((s) => s.scene_index).join(", ")} use phone as the central prop. Use clock, keys, calendar, route-map, door, coffee, or shoes unless the story is specifically about a phone.`);
  }

  if (isDoorwayOrSpatialTopic(contentScenes)) {
    const doorwayPropScenes = contentScenes.filter((scene) => propValue(scene) === "door" && !/\b(?:cross|through|walk|enter|leave|open|doorway)\b/i.test(scene.point ?? ""));
    if (doorwayPropScenes.length > 0) errors.push(`${def.name}@${def.version ?? "1"} doorway prop gate failed: scenes ${doorwayPropScenes.map((s) => s.scene_index).join(", ")} use door as a central prop without crossing/opening action. Use the remembered object instead, and keep the door as a scene transition/set-piece.`);
  }

  // Mirrors cartoon-scenes.ts's assertV3ScriptContract, run here (writer
  // stage, with retry-and-feedback) instead of only at the compiler worker
  // stage. A script whose final scene doesn't actually resolve -- e.g. it
  // ends mid-explanation on a "transition" beat instead of a payoff -- used
  // to pass this gate, get stored, and only fail later at the compiler,
  // which has no retry and blocks the run permanently on a script that
  // can't be regenerated without a fresh run.
  if (Number(def.version ?? "1") >= 3) {
    const estimatedDurationSec = contentScenes.reduce((sum, scene) => sum + wordCount(scene.narration), 0) / WORDS_PER_SECOND;
    const pointLines = contentScenes.map((scene) => (scene.point ?? "").toLowerCase());
    const finalPoint = pointLines[pointLines.length - 1] ?? "";

    if (!/(payoff|resolve|resolution|return|opening|final|lands|closes|changed_behavior|habit|confirm)/.test(finalPoint)) {
      errors.push(`${def.name}@${def.version ?? "1"} contract violated: final scene point must mark a payoff/resolution of the opening situation`);
    } else if (estimatedDurationSec >= LONG_SCRIPT_SECONDS) {
      // "correction" covers the comprehension-structure genre (dialogue_script_writer@10+):
      // its midpoint-turn equivalent is the beat where the objection's gap gets resolved.
      if (!pointLines.some((point) => /(midpoint|turn|reframe|reversal|correction)/.test(point))) {
        errors.push(`${def.name}@${def.version ?? "1"} contract violated: long scripts must include a midpoint turn/reframe point`);
      }
      // "objection" and "visual_model" cover the comprehension-structure genre: a
      // surprising counter-example and a concrete demonstration are that genre's
      // narrative engagement, in place of a joke/callback/visual-gag/pun beat.
      const engagementCount = pointLines.filter((point) => /(engagement|joke|callback|contradiction|visual.?gag|punchline|absurd|pun|objection|visual_model)/.test(point)).length;
      if (engagementCount < 2) {
        errors.push(`${def.name}@${def.version ?? "1"} contract violated: long scripts must include at least two engagement beats in scene points`);
      }
    }
  }

  return errors;
}

function longestRun(values: string[]): number {
  let best = 0;
  let current = 0;
  let last = "";
  for (const value of values) {
    if (!value) continue;
    current = value === last ? current + 1 : 1;
    best = Math.max(best, current);
    last = value;
  }
  return best;
}

function countScenesWith(scenes: PlanScene[], predicate: (scene: PlanScene) => boolean): number {
  return scenes.reduce((count, scene) => count + (predicate(scene) ? 1 : 0), 0);
}

function planText(scene: PlanScene): string {
  return [
    scene.background_location,
    scene.background_variant,
    scene.framing,
    scene.camera_motion,
    scene.visual_event,
    scene.primary_prop,
    scene.prop_state,
    scene.prop_motion,
    scene.foreground_action,
  ].join(" ").toLowerCase();
}

function isDoorSetPieceScene(scene: PlanScene): boolean {
  return /\b(?:door|doorway|hallway|corridor|threshold)\b/i.test(planText(scene));
}

function isVisibleCrossingBeat(scene: PlanScene): boolean {
  // Structured fields are the authoritative signal -- exactly what the prompt
  // teaches the model to set for a crossing beat, and unambiguous.
  const location = String(scene.background_location ?? "").toLowerCase();
  const framing = String(scene.framing ?? "").toLowerCase();
  const cameraMotion = String(scene.camera_motion ?? "").toLowerCase();
  if (location === "hallway" || framing === "doorway-transition" || cameraMotion === "doorway-track") return true;

  // Prose fallback for plans that describe the crossing without those exact
  // enum values. Deliberately narrow: "door"/"room"/"open" alone are too
  // common on unrelated objects (a fridge door, a car door, "living-room" as
  // a location) and were misfiring as a false crossing beat on the very
  // first scene, which broke the room-A/room-B ordering check below.
  const text = planText(scene);
  return /\b(?:cross|crosses|crossing|through|enter|enters|leave|leaves|leaving)\b.*\b(?:doorway|threshold|hallway|corridor)\b/.test(text)
    || /\b(?:doorway|threshold|hallway|corridor)\b.*\b(?:cross|crosses|crossing|through|enter|enters|leave|leaves|leaving)\b/.test(text);
}

function isRoomALocation(scene: PlanScene): boolean {
  return /\b(?:living-room|bedroom|office|kitchen|generic-room|room)\b/i.test(scene.background_location ?? "") && !isVisibleCrossingBeat(scene);
}

function isRoomBLocation(scene: PlanScene, roomABeforeCrossing: string | undefined): boolean {
  const location = String(scene.background_location ?? "").toLowerCase();
  if (!/\b(?:kitchen|office|bedroom|living-room|street|cafe|library|shop|classroom|bathroom|generic-room)\b/.test(location)) return false;
  if (!roomABeforeCrossing) return true;
  return location !== roomABeforeCrossing;
}

function doorwayContinuityFailure(planned: PlanScene[]): string | null {
  const crossingIndex = planned.findIndex(isVisibleCrossingBeat);
  if (crossingIndex < 0) {
    return "doorway/spatial episode lacks a visible crossing beat; include at least one scene with background_location=hallway, framing=doorway-transition, camera_motion=doorway-track, primary_prop=door, and foreground_action describing the character crossing/opening the doorway";
  }

  const beforeCrossing = planned.slice(0, crossingIndex);
  const afterCrossing = planned.slice(crossingIndex + 1);
  const roomABeforeCrossing = beforeCrossing.find(isRoomALocation)?.background_location?.toLowerCase();
  const hasRoomA = Boolean(roomABeforeCrossing);
  const hasRoomB = afterCrossing.some((scene) => isRoomBLocation(scene, roomABeforeCrossing));

  if (!hasRoomA || !hasRoomB) {
    return "doorway/spatial episode lacks ordered continuity: require a room A scene before the crossing beat and a different room B scene after it, for example living-room -> hallway/doorway-transition -> kitchen";
  }
  return null;
}

function validateCartoonVisualPlan(payload: unknown, inputs: Record<string, Artifact>): string[] {
  // Product direction: storytelling and concept explanation over cinematic
  // shot/environment variety. Dropped the environment-distinctness,
  // environment-repeat-run, framing-variety, camera-motion-variety,
  // doorway/set-piece proportion, and ambient-motion-coverage checks -- all
  // purely visual-polish concerns that cost retry cycles without affecting
  // whether the concept lands. Kept the one check that's actually
  // comprehension-relevant: a central prop the episode leans on for its
  // demonstration needs a real physical action, not just decorative
  // presence, since that's how the visual model beat communicates anything.
  const contentScenes = inputScriptScenes(inputs).filter((scene) => !scene.is_outro).sort((a, b) => a.scene_index - b.scene_index);
  const planned = planScenes(payload).sort((a, b) => a.scene_index - b.scene_index);
  if (contentScenes.length < LONG_CARTOON_PLAN_SCENES) return [];

  const failures: string[] = [];

  const propScenes = planned.filter((scene) => normalizedProp(scene.primary_prop ?? "") && normalizedProp(scene.primary_prop ?? "") !== "none");
  const actionlessProps = propScenes.filter((scene) => !scene.foreground_action || /^\s*(none|present|visible)\s*$/i.test(scene.foreground_action));
  if (actionlessProps.length > Math.max(1, Math.floor(propScenes.length * 0.35))) failures.push(`too many central props lack physical foreground_action (${actionlessProps.length}/${propScenes.length}); props must be held, placed, opened, crossed, picked up, or looked at`);

  if (isDoorwayOrSpatialTopic(contentScenes)) {
    const continuityFailure = doorwayContinuityFailure(planned);
    if (continuityFailure) failures.push(continuityFailure);
  }

  return failures.length === 0 ? [] : [`cartoon_visual_planner explanation-action gate failed: ${failures.join("; ")}. Revise only the physical demonstration or required spatial continuity before scene compilation.`];
}

export function agentSemanticValidationErrors(
  def: AgentDef,
  payload: unknown,
  inputs: Record<string, Artifact>,
): string[] {
  if ((["dialogue_script_writer", "comprehension_editor", "retention_character_editor", "emotional_entertainment_editor", "script_quality_reviser"].includes(def.name)) && def.produces === "script") {
    return validateDialogueScript(payload, def);
  }
  if (def.name === "cartoon_visual_planner" && def.produces === "visual_plan") return validateCartoonVisualPlan(payload, inputs);
  return [];
}
