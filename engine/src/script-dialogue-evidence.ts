export interface DialogueEvidenceCheck {
  id: string;
  passed: boolean;
  message: string;
  measured?: number;
  threshold?: number;
}

export interface DialogueEvidenceAssessment {
  passed: boolean;
  coverage: number;
  checks: DialogueEvidenceCheck[];
  failures: string[];
}

interface ScriptScene {
  scene_index?: number;
  speaker?: string;
  narration?: string;
  point?: string;
  is_outro?: boolean;
}

interface ScriptPayload {
  scenes?: ScriptScene[];
}

const REQUIRED_FUNCTIONS = [
  "hook",
  "intuitive_answer",
  "objection",
  "visual_model",
  "correction",
  "implication",
  "takeaway practical_action",
  "recap confirms_understanding",
] as const;

function field(point: string, key: string): string {
  const match = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;]+)`, "i").exec(point);
  return match?.[1]?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}

function words(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function normalizedProp(value: string): string {
  return value.toLowerCase().replace(/\b(?:a|an|the|this|that|central|model|prop)\b/g, " ").replace(/\s+/g, " ").trim();
}

function add(
  checks: DialogueEvidenceCheck[],
  id: string,
  passed: boolean,
  message: string,
  measured?: number,
  threshold?: number,
): void {
  checks.push({
    id,
    passed,
    message,
    ...(measured !== undefined ? { measured } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
  });
}

export function assessDialogueEvidence(payload: unknown): DialogueEvidenceAssessment {
  const script = payload && typeof payload === "object" ? payload as ScriptPayload : {};
  const scenes = (script.scenes ?? [])
    .filter((scene) => !scene.is_outro)
    .sort((a, b) => (a.scene_index ?? 0) - (b.scene_index ?? 0));
  const checks: DialogueEvidenceCheck[] = [];

  if (scenes.length === 0) {
    return {
      passed: false,
      coverage: 0,
      checks: [{ id: "dialogue_present", passed: false, message: "no dialogue scenes were present" }],
      failures: ["dialogue_present: no dialogue scenes were present"],
    };
  }

  const speakers = scenes.map((scene) => scene.speaker?.trim() ?? "").filter(Boolean);
  const counts = new Map<string, number>();
  for (const speaker of speakers) counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
  const speakerCounts = [...counts.values()].sort((a, b) => a - b);
  const minorityRatio = speakers.length > 0 && speakerCounts.length >= 2 ? speakerCounts[0]! / speakers.length : 0;
  add(
    checks,
    "two_active_characters",
    counts.size === 2 && minorityRatio >= 0.25,
    counts.size === 2
      ? `minority character owns ${Math.round(minorityRatio * 100)}% of spoken turns`
      : `expected exactly two active speakers, found ${counts.size}`,
    minorityRatio,
    0.25,
  );

  let switches = 0;
  let longestRun = 0;
  let run = 0;
  let previous = "";
  for (const speaker of speakers) {
    if (speaker !== previous) {
      if (previous) switches++;
      run = 1;
      previous = speaker;
    } else {
      run++;
    }
    longestRun = Math.max(longestRun, run);
  }
  const switchRatio = speakers.length > 1 ? switches / (speakers.length - 1) : 0;
  add(
    checks,
    "responsive_turn_taking",
    switchRatio >= 0.60 && longestRun <= 3,
    `speaker changes on ${Math.round(switchRatio * 100)}% of transitions; longest same-speaker run is ${longestRun}`,
    switchRatio,
    0.60,
  );

  const functions = scenes.map((scene) => field(scene.point ?? "", "function"));
  const positions = REQUIRED_FUNCTIONS.map((fn) => functions.findIndex((value) => value === fn));
  const allPresent = positions.every((position) => position >= 0);
  const ordered = allPresent && positions.every((position, index) => index === 0 || position > positions[index - 1]!);
  add(
    checks,
    "comprehension_arc",
    ordered,
    ordered
      ? "all eight comprehension functions appear in causal order"
      : `required function order is incomplete or broken: ${REQUIRED_FUNCTIONS.filter((_, i) => positions[i]! < 0).join(", ") || "order mismatch"}`,
    positions.filter((position) => position >= 0).length,
    REQUIRED_FUNCTIONS.length,
  );

  const hookIndex = functions.indexOf("hook");
  const hookText = scenes.slice(0, 2).map((scene) => scene.narration ?? "").join(" ");
  const hookHasOpenLoop = /\?|\b(?:but|why|how|except|should|supposed|doesn['’]?t|can['’]?t|wrong|impossible|strange|weird|then)\b/i.test(hookText);
  add(
    checks,
    "specific_open_loop",
    hookIndex >= 0 && hookIndex <= 1 && hookHasOpenLoop,
    hookIndex <= 1 && hookHasOpenLoop
      ? "the first two turns establish an unresolved question or contradiction"
      : "the opening lacks a detectable unresolved question or contradiction",
  );

  const modelIndex = functions.indexOf("visual_model");
  const preModelText = scenes.slice(0, Math.max(0, modelIndex)).map((scene) => `${scene.narration ?? ""} ${scene.point ?? ""}`).join(" ");
  const predictionPresent = /\b(?:predict|prediction|expect|guess|bet|think|should|will|would|if .* then)\b/i.test(preModelText);
  const objectionIndex = functions.indexOf("objection");
  add(
    checks,
    "prediction_before_contradiction",
    modelIndex > 0 && objectionIndex >= 0 && objectionIndex < modelIndex && predictionPresent,
    predictionPresent && objectionIndex < modelIndex
      ? "a character commits to an expectation before the model exposes the mismatch"
      : "the model is missing a detectable prediction followed by an objection",
  );

  const modelScenes = scenes.filter((_, index) => functions[index] === "visual_model");
  const physicalModel = modelScenes.some((scene) =>
    /\b(?:add|remove|move|place|open|close|cross|stack|split|pour|draw|point|line|compare|swap|turn|drop|pick|push|pull|show|change|cover|reveal|count|arrange|build)\w*\b/i.test(field(scene.point ?? "", "action"))
  );
  add(
    checks,
    "physical_explanation_model",
    modelScenes.length > 0 && physicalModel,
    physicalModel
      ? "the visual model contains an observable state-changing action"
      : "the visual model is described without an observable state-changing action",
  );

  const modelProps = modelScenes.map((scene) => normalizedProp(field(scene.point ?? "", "prop"))).filter((prop) => prop && prop !== "none");
  const recapIndex = functions.indexOf("recap confirms_understanding");
  const recapProp = recapIndex >= 0 ? normalizedProp(field(scenes[recapIndex]!.point ?? "", "prop")) : "";
  const stableProp = modelProps.length > 0 && Boolean(recapProp) && modelProps.includes(recapProp);
  add(
    checks,
    "model_reused_in_recap",
    stableProp,
    stableProp
      ? `the recap reuses the explanatory model "${recapProp}"`
      : "the recap does not reuse the central prop from the visual model",
  );

  const reasoningFunctions = new Set([
    "intuitive_answer",
    "objection",
    "visual_model",
    "correction",
    "implication",
    "takeaway practical_action",
    "recap confirms_understanding",
  ]);
  const causalSpeakers = new Set(
    scenes
      .filter((_, index) => reasoningFunctions.has(functions[index]!))
      .map((scene) => scene.speaker?.trim() ?? "")
      .filter(Boolean),
  );
  add(
    checks,
    "both_characters_advance_reasoning",
    counts.size === 2 && causalSpeakers.size === 2,
    causalSpeakers.size === 2
      ? "both characters cause at least one reasoning advance"
      : "one character is only reacting rather than advancing the explanation",
    causalSpeakers.size,
    2,
  );

  const values = scenes.map((scene) => field(scene.point ?? "", "value"));
  const weakValues = values.filter((value) =>
    words(value) < 4 || /^(?:viewer|audience) (?:learns|understands|sees) (?:the )?(?:idea|concept|point|answer)$/.test(value)
  ).length;
  add(
    checks,
    "specific_understanding_changes",
    weakValues === 0,
    weakValues === 0
      ? "every beat records a specific change in understanding"
      : `${weakValues} beat values are absent or generic`,
    weakValues,
    0,
  );

  const recapScene = recapIndex >= 0 ? scenes[recapIndex]! : undefined;
  const recapText = recapScene?.narration ?? "";
  const recapIsFinal = recapIndex === scenes.length - 1;
  const nonSummaryTeachBack = words(recapText) >= 6 && !/\b(?:lesson is|in summary|to summarize|so basically|what we learned)\b/i.test(recapText);
  add(
    checks,
    "final_teach_back",
    recapIsFinal && nonSummaryTeachBack,
    recapIsFinal && nonSummaryTeachBack
      ? "the final turn applies or reconstructs the corrected idea"
      : "the final turn is not a substantive teach-back payoff",
  );

  const passedCount = checks.filter((check) => check.passed).length;
  const failures = checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.message}`);
  return {
    passed: failures.length === 0,
    coverage: checks.length > 0 ? passedCount / checks.length : 0,
    checks,
    failures,
  };
}
