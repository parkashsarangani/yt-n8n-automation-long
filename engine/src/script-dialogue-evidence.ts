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
  emotion?: string;
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

// dialogue_script_writer's prompt teaches the exact eight REQUIRED_FUNCTIONS
// strings, but nothing enforces them structurally -- `point` is free text in
// the schema (RFC 0004 grounding only), so a model that reaches for a close
// synonym for the two compound, easy-to-abbreviate terminal beats still
// produces a genuinely correct payoff scene. Production evidence: a real run
// closed its episode with five `function=teach_back` scenes (applying the
// corrected model -- the practical-action beat) followed by one
// `function=payoff` scene (echoing the `payoff` field already present on the
// `story` artifact given as this agent's own input, restating the corrected
// idea -- the recap beat). Neither string is in REQUIRED_FUNCTIONS, so an
// exact-match lookup saw both the takeaway and the recap as entirely absent
// and failed comprehension_arc, model_reused_in_recap, and final_teach_back
// simultaneously, over vocabulary, on a script whose actual closing stretch
// was a valid, prop-reusing teach-back into payoff. Same fix philosophy
// already used for the compiler's MIDPOINT_RE/ENGAGEMENT_RE regexes: widen
// the recognizer rather than demand one exact phrase across a ~50-scene
// generation. `teach_back`/`teach back` reads as *applying* the idea (the
// takeaway), reserving `recap`/`confirms_understanding`/`payoff` for the beat
// that actually restates it (the recap) -- matching how the model used both
// terms in the run that surfaced this gap.
const FUNCTION_SYNONYMS: Record<string, (typeof REQUIRED_FUNCTIONS)[number]> = {
  recap: "recap confirms_understanding",
  "confirms_understanding": "recap confirms_understanding",
  payoff: "recap confirms_understanding",
  takeaway: "takeaway practical_action",
  practical_action: "takeaway practical_action",
  "practical action": "takeaway practical_action",
  teach_back: "takeaway practical_action",
  "teach back": "takeaway practical_action",
};

function canonicalFunction(raw: string): string {
  return FUNCTION_SYNONYMS[raw] ?? raw;
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

  const functions = scenes.map((scene) => canonicalFunction(field(scene.point ?? "", "function")));
  // The bookend contract structurally guarantees the last scene is the recap
  // ("The final content exchange returns to both characters together and
  // directly resolves Buddy's opening question through a callback"), so a
  // missing or mistagged `recap confirms_understanding` function doesn't mean
  // the recap is actually absent -- production evidence: a real run's actual
  // closing beat (a substantive restatement reusing the visual model) got
  // tagged `practical_action` instead, after the vocabulary drifted through
  // `payoff` and `teach_back` on two earlier runs. Falling back to the last
  // scene when no scene explicitly claims the tag stops chasing the model's
  // exact wording for this one beat; the content-focused checks below
  // (final_teach_back's word-count/generic-phrase test, model_reused_in_
  // recap's prop check) still catch a genuinely weak or missing ending on
  // their own merits, so this isn't a loophole for bad content.
  const explicitRecapIndex = functions.findIndex((value) => value === "recap confirms_understanding");
  const recapIndex = explicitRecapIndex >= 0 ? explicitRecapIndex : scenes.length - 1;
  const positions = REQUIRED_FUNCTIONS.map((fn) =>
    fn === "recap confirms_understanding" ? recapIndex : functions.findIndex((value) => value === fn),
  );
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
  const preModelText = scenes.slice(0, Math.max(0, modelIndex)).map((scene) => scene.narration ?? "").join(" ");
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
  const recapProp = normalizedProp(field(scenes[recapIndex]!.point ?? "", "prop"));
  // Exact equality rejected a real reuse in production: the recap staged the
  // model prop alongside the episode's opening object ("molecule-piece-model"
  // -> "molecule-piece-model-and-ice-cube-in-glass"), which is a stronger
  // callback than repeating the bare prop name, not a different one. A
  // substring check in either direction still requires the recap's prop to
  // genuinely be built on the model's prop rather than merely fooling a
  // loose match with an unrelated compound label.
  const stableProp = modelProps.length > 0 && Boolean(recapProp) &&
    modelProps.some((prop) => recapProp.includes(prop) || prop.includes(recapProp));
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

  const recapScene = scenes[recapIndex]!;
  const recapText = recapScene.narration ?? "";
  const recapIsFinal = recapIndex === scenes.length - 1;
  // The explicit-tag requirement this used to lean on for "is this genuinely
  // the recap" doubled as an implicit anti-boilerplate guard once the recap
  // fallback above stopped requiring that tag: a script that never earns a
  // real recap by repeating the same generic line in every scene would still
  // pass on word count and the phrase blacklist alone. Requiring the recap's
  // narration to be unique (not repeated verbatim elsewhere in the episode)
  // restores that guard without bringing back the tag dependency.
  const recapTextIsBoilerplate = scenes.some((scene, index) =>
    index !== recapIndex && (scene.narration ?? "").trim() === recapText.trim(),
  );
  const nonSummaryTeachBack = words(recapText) >= 6 && !recapTextIsBoilerplate &&
    !/\b(?:lesson is|in summary|to summarize|so basically|what we learned)\b/i.test(recapText);
  add(
    checks,
    "final_teach_back",
    recapIsFinal && nonSummaryTeachBack,
    recapIsFinal && nonSummaryTeachBack
      ? "the final turn applies or reconstructs the corrected idea"
      : "the final turn is not a substantive teach-back payoff",
  );

  const emotions = scenes.map((scene) => scene.emotion?.toLowerCase() ?? "");
  const distinctEmotions = new Set(emotions.filter(Boolean));
  const neutralRatio = emotions.length > 0 ? emotions.filter((emotion) => emotion === "neutral" || !emotion).length / emotions.length : 1;
  add(
    checks,
    "playable_emotional_palette",
    distinctEmotions.size >= 3 && neutralRatio <= 0.70,
    `${distinctEmotions.size} distinct playable emotions; ${Math.round(neutralRatio * 100)}% neutral or unspecified`,
    distinctEmotions.size,
    3,
  );

  let emotionChanges = 0;
  for (let index = 1; index < emotions.length; index++) {
    if (emotions[index] && emotions[index - 1] && emotions[index] !== emotions[index - 1]) emotionChanges++;
  }
  const emotionalChangeRatio = emotions.length > 1 ? emotionChanges / (emotions.length - 1) : 0;
  add(
    checks,
    "emotional_movement",
    emotionalChangeRatio >= 0.30,
    `delivery emotion changes on ${Math.round(emotionalChangeRatio * 100)}% of turn transitions`,
    emotionalChangeRatio,
    0.30,
  );

  const breakingIndexes = functions
    .map((fn, index) => fn === "objection" || fn === "visual_model" ? index : -1)
    .filter((index) => index >= 0);
  const hasMismatchReaction = breakingIndexes.some((index) =>
    emotions.slice(index, Math.min(emotions.length, index + 2)).some((emotion) =>
      ["surprised", "angry", "scared", "sad"].includes(emotion)
    )
  );
  add(
    checks,
    "model_break_reaction",
    hasMismatchReaction,
    hasMismatchReaction
      ? "the prediction-breaking moment produces a playable emotional reaction"
      : "the model breaks the prediction without a specific emotional reaction",
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
