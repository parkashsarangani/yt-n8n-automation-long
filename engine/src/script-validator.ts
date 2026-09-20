/**
 * Deterministic structural checks on a generated script.
 *
 * The script prompt states a dozen numeric rules -- a per-scene word cap, a
 * ceiling on how late the first usable reply may arrive, a budget for what
 * follows the payoff -- and until now every one of them was enforced only by
 * asking a model to obey prose. Observed drafts violated them while passing
 * every gate: a 150-word scene, a first reply at word 82, and an episode that
 * satisfied its post-payoff word budget by moving the [payoff] tag onto a
 * later summary while the real resolution sat under [limitations].
 *
 * That last one is the reason this module exists. A rule keyed off a label the
 * same model chooses is gameable by construction. So the checks here are
 * computed from the text -- cumulative word positions, dialogue placement --
 * and where a check must consult a tag, it cross-examines the tag against the
 * prose rather than trusting it.
 *
 * Scope, stated honestly: these catch mechanical violations, not dull writing.
 * Nothing here knows whether an episode is worth watching.
 */

/** The prompt's own stated numbers. Changing one here changes the check only. */
export const SCENE_WORD_CAP = 90;
export const FIRST_REPLY_WORD_CEILING = 90;
export const POST_PAYOFF_WORD_CAP = 55;
export const POST_PAYOFF_RATIO_CAP = 0.15;
export const OUTRO_WORD_CAP = 22;
export const NAVIGATION_LABEL_CHAR_CAP = 48;
export const PAYOFF_MIN_POSITION_RATIO = 2 / 3;
/** One opening address plus one closing discussion invitation. */
export const MAX_NARRATOR_QUESTIONS = 2;
/**
 * Share of substantive scenes that must address the listener outside
 * dialogue. Not 100 percent: an explanation beat may legitimately describe
 * the mechanism rather than the listener, and demanding a "you" in every
 * scene would be satisfied with filler.
 */
export const SECOND_PERSON_SCENE_COVERAGE = 0.7;

/**
 * Beats that tell the listener about the situation rather than moving them
 * through it. Grouped because the register is what flattens an episode, not
 * the label: a run of these is a lecture whatever the tags say.
 */
export const TEACHING_ROLES = new Set(["explanation", "limitations", "exercise"]);
export const MAX_CONSECUTIVE_TEACHING_SCENES = 2;

/**
 * Direct address. The episode opens by putting the listener inside a moment
 * they recognise, and comes back to them at least once afterwards.
 *
 * Only the countable part is checked here. Whether an opening is *relatable*
 * is not decidable in code, and the last thing that claimed to judge that was
 * a model scoring another model. What code can settle is whether the second
 * person is present at all, and whether the address describes a situation or
 * diagnoses the listener -- and the second of those is the one that matters.
 */
export const SECOND_PERSON = /\b(you|your|you're|you've|you'd|you'll|yours|yourself)\b/i;

/**
 * Character diagnosis, which stays banned. A synthetic narrator telling a
 * listener what is wrong with them is false intimacy and presumptuous, and
 * this channel's audience is by definition people who may already feel
 * inadequate. Situations are shared; character judgements are not.
 *
 * Deliberately narrow: it matches copular trait claims ("you are shy", "you're
 * the kind of person who", "if you're anxious"), not any sentence containing
 * "you". The whole episode is now written with the listener as protagonist, so
 * a broad rule would reject the second-person narration the prompt requires --
 * "you said nothing" is the scenario, not a judgement.
 */
export const CHARACTER_DIAGNOSIS = new RegExp(
  [
    "\\byou(?:'re| are)\\s+(?:a|an|the\\s+kind\\s+of|the\\s+type\\s+of|someone|somebody|just|too|so|naturally|simply)?\\s*",
    "(?:shy|anxious|awkward|insecure|timid|nervous|passive|weak|incapable|inadequate|unconfident|introverted)",
    // "you're the kind of person who…" / "you are someone who…" -- a trait
    // claim that names no adjective at all, which the list above would miss.
    "|\\byou(?:'re| are)\\s+(?:a|an|the)\\s+(?:kind|type|sort)\\s+of\\s+(?:person|people|one)\\b",
    "|\\byou(?:'re| are)\\s+(?:someone|somebody)\\s+who\\b",
    "|\\bif\\s+you(?:'re| are)\\s+(?:shy|anxious|awkward|insecure|timid|nervous|passive|weak|incapable|inadequate|unconfident)",
    "|\\byou\\s+(?:lack|can't\\s+seem\\s+to|have\\s+never\\s+been\\s+able\\s+to)\\b",
    // Deliberately NOT matching "you always/never <verb>". Now that the whole
    // episode is written with the listener as protagonist, "you never said a
    // word" is scene narration, not a trait claim, and the two are not
    // separable by pattern. A rule that rejects correct scripts is worse than
    // no rule; the copular forms above carry the real signal.
  ].join(""),
  "i",
);

export const REQUIRED_ROLES = [
  "scenario",
  "response_a",
  "response_b",
  "explanation",
  "limitations",
  "exercise",
  "payoff",
] as const;

/**
 * Every rule this module can report. A closed union rather than free-form
 * strings because these ids are aggregation keys: a typo in one of the push
 * sites below would otherwise compile cleanly and silently create a second,
 * uncounted bucket in the violation report, and the only symptom would be a
 * report that looks slightly odd.
 */
export type ViolationRule =
  | "no_scenes"
  | "missing_role"
  | "first_scene_not_scenario"
  | "scene_word_cap"
  | "stacked_explanation"
  | "no_response_scene"
  | "first_reply_too_late"
  | "payoff_too_early"
  | "post_payoff_word_cap"
  | "post_payoff_ratio"
  | "payoff_tag_suspect"
  | "no_discussion_question"
  | "multiple_questions"
  | "outro_word_cap"
  | "outro_is_question"
  | "no_outro"
  | "label_too_long"
  | "no_direct_address"
  | "no_opening_question"
  | "character_diagnosis"
  | "protagonist_not_the_listener"
  | "teaching_run"
  | "dialogue_drought";

export interface ScriptViolation {
  /** Stable identifier so violation rates can be counted per rule over time. */
  rule: ViolationRule;
  detail: string;
}

export interface ParsedScene {
  index: number;
  role: string | null;
  label: string;
  narration: string;
  words: number;
  /** Words completed before this scene starts. */
  wordsBefore: number;
  isOutro: boolean;
  hasDialogue: boolean;
}

export interface ScriptValidation {
  ok: boolean;
  violations: ScriptViolation[];
  scenes: ParsedScene[];
  totalWords: number;
  /** Substantive words, i.e. excluding the outro the release worker replaces. */
  substantiveWords: number;
}

type RawScene = { scene_index?: unknown; point?: unknown; narration?: unknown; is_outro?: unknown };

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** `[response_b] Attach authorship to useful detail` -> role + navigation label. */
function parsePoint(point: string): { role: string | null; label: string } {
  const match = /^\s*\[([a-z0-9_]+)\]\s*(.*)$/i.exec(point);
  if (!match) return { role: null, label: point.trim() };
  return { role: match[1]!.toLowerCase(), label: match[2]!.trim() };
}

/**
 * Straight and typographic quotes both appear in real drafts. Dialogue is the
 * signal used to cross-examine the payoff tag: the resolution is an exchange,
 * a summary of it is not.
 */
function containsDialogue(narration: string): boolean {
  return /["“”]/.test(narration);
}

/**
 * Narration with quoted speech removed, so a rule about the narrator's own
 * sentences is not confused by what a character says.
 */
export function stripDialogue(narration: string): string {
  return narration
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"]*"/g, " ");
}

export function parseScenes(payload: unknown): ParsedScene[] {
  const scenes = (payload as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  const out: ParsedScene[] = [];
  let running = 0;
  for (const [i, raw] of scenes.entries()) {
    const scene = (raw ?? {}) as RawScene;
    const narration = typeof scene.narration === "string" ? scene.narration : "";
    const point = typeof scene.point === "string" ? scene.point : "";
    const { role, label } = parsePoint(point);
    const words = countWords(narration);
    out.push({
      index: typeof scene.scene_index === "number" ? scene.scene_index : i,
      role,
      label,
      narration,
      words,
      wordsBefore: running,
      isOutro: scene.is_outro === true,
      hasDialogue: containsDialogue(narration),
    });
    running += words;
  }
  return out;
}

export function validateScriptStructure(payload: unknown): ScriptValidation {
  const scenes = parseScenes(payload);
  const violations: ScriptViolation[] = [];
  const totalWords = scenes.reduce((sum, s) => sum + s.words, 0);

  if (scenes.length === 0) {
    return { ok: false, violations: [{ rule: "no_scenes", detail: "script has no scenes" }], scenes, totalWords: 0, substantiveWords: 0 };
  }

  const substantive = scenes.filter((s) => !s.isOutro);
  const substantiveWords = substantive.reduce((sum, s) => sum + s.words, 0);

  // 1. Every required role appears at least once.
  const roles = new Set(scenes.map((s) => s.role).filter((r): r is string => r !== null));
  for (const required of REQUIRED_ROLES) {
    if (!roles.has(required)) {
      violations.push({ rule: "missing_role", detail: `no [${required}] scene` });
    }
  }

  // 2. The episode opens on the situation, not on setup.
  if (scenes[0]!.role !== "scenario") {
    violations.push({ rule: "first_scene_not_scenario", detail: `opens on [${scenes[0]!.role ?? "untagged"}]` });
  }

  // 3. Per-scene word cap. A scene past this is carrying two jobs.
  for (const scene of scenes) {
    if (!scene.isOutro && scene.words > SCENE_WORD_CAP) {
      violations.push({
        rule: "scene_word_cap",
        detail: `scene ${scene.index} [${scene.role ?? "untagged"}] runs ${scene.words} words (cap ${SCENE_WORD_CAP})`,
      });
    }
  }

  // 4. Explanation may not be stacked: the scene after one must dramatise.
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i]!.role === "explanation" && scenes[i - 1]!.role === "explanation") {
      violations.push({
        rule: "stacked_explanation",
        detail: `scenes ${scenes[i - 1]!.index} and ${scenes[i]!.index} are both [explanation]`,
      });
    }
  }

  // 4b. The same failure wearing three different labels.
  //
  // The rule above compares [explanation] to [explanation], so a run of
  // [explanation] -> [limitations] -> [exercise] slipped past it -- which is
  // exactly what production produced. All three are the teaching register:
  // they tell the listener about the situation instead of moving them through
  // it, and three in a row is a lecture with a story stapled to each end.
  let run: ParsedScene[] = [];
  const flushTeachingRun = () => {
    if (run.length > MAX_CONSECUTIVE_TEACHING_SCENES) {
      violations.push({
        rule: "teaching_run",
        detail:
          `scenes ${run.map((s) => s.index).join(", ")} are ${run.length} teaching beats in a row ` +
          `(${run.map((s) => `[${s.role}]`).join(" -> ")}; at most ${MAX_CONSECUTIVE_TEACHING_SCENES})`,
      });
    }
    run = [];
  };
  for (const scene of scenes) {
    if (!scene.isOutro && scene.role !== null && TEACHING_ROLES.has(scene.role)) run.push(scene);
    else flushTeachingRun();
  }
  flushTeachingRun();

  // 4c. Structural cross-check, because the roles above are model-chosen and
  //     a rule keyed off a label is gameable by relabelling. Quoted speech is
  //     the cheapest evidence that a scene is happening rather than being
  //     described; a long stretch without any is the same flatness even if
  //     every tag says otherwise.
  let silent: ParsedScene[] = [];
  const flushSilentRun = () => {
    if (silent.length > MAX_CONSECUTIVE_TEACHING_SCENES) {
      violations.push({
        rule: "dialogue_drought",
        detail: `scenes ${silent.map((s) => s.index).join(", ")} contain no spoken line between them`,
      });
    }
    silent = [];
  };
  for (const scene of substantive) {
    if (!scene.hasDialogue) silent.push(scene);
    else flushSilentRun();
  }
  flushSilentRun();

  // 5. The first usable reply has a mechanical word ceiling.
  const firstReply = scenes.find((s) => s.role === "response_a" || s.role === "response_b");
  if (!firstReply) {
    violations.push({ rule: "no_response_scene", detail: "neither [response_a] nor [response_b] appears" });
  } else if (firstReply.wordsBefore + firstReply.words > FIRST_REPLY_WORD_CEILING) {
    violations.push({
      rule: "first_reply_too_late",
      detail: `first reply completes at word ${firstReply.wordsBefore + firstReply.words} (ceiling ${FIRST_REPLY_WORD_CEILING})`,
    });
  }

  // 6-8. Payoff placement, computed from word position, then cross-examined.
  const payoff = scenes.find((s) => s.role === "payoff");
  if (payoff) {
    const startRatio = substantiveWords > 0 ? payoff.wordsBefore / substantiveWords : 0;
    if (startRatio < PAYOFF_MIN_POSITION_RATIO) {
      violations.push({
        rule: "payoff_too_early",
        detail: `[payoff] starts at ${(startRatio * 100).toFixed(0)}% of the episode (must be past ${(PAYOFF_MIN_POSITION_RATIO * 100).toFixed(0)}%)`,
      });
    }

    const after = scenes.filter((s) => !s.isOutro && s.wordsBefore >= payoff.wordsBefore + payoff.words);
    const afterWords = after.reduce((sum, s) => sum + s.words, 0);
    if (afterWords > POST_PAYOFF_WORD_CAP) {
      violations.push({
        rule: "post_payoff_word_cap",
        detail: `${afterWords} words follow the payoff (cap ${POST_PAYOFF_WORD_CAP})`,
      });
    }
    if (substantiveWords > 0 && afterWords / substantiveWords > POST_PAYOFF_RATIO_CAP) {
      violations.push({
        rule: "post_payoff_ratio",
        detail: `${((afterWords / substantiveWords) * 100).toFixed(0)}% of words follow the payoff (cap ${(POST_PAYOFF_RATIO_CAP * 100).toFixed(0)}%)`,
      });
    }

    // The anti-gaming check. If the decisive exchange happened in an earlier
    // scene and [payoff] holds no dialogue at all, the tag is describing a
    // recap -- which is exactly how a post-payoff word budget gets satisfied
    // without the episode actually resolving late.
    const lastDialogue = [...scenes].reverse().find((s) => !s.isOutro && s.hasDialogue);
    if (lastDialogue && !payoff.hasDialogue && lastDialogue.wordsBefore < payoff.wordsBefore) {
      violations.push({
        rule: "payoff_tag_suspect",
        detail:
          `[payoff] (scene ${payoff.index}) contains no dialogue while scene ${lastDialogue.index} ` +
          `[${lastDialogue.role ?? "untagged"}] holds the last spoken exchange -- the tag may be on a recap`,
      });
    }
  }

  // 9a. The episode opens by addressing the listener, and keeps doing so.
  const opener = scenes[0]!;
  if (!SECOND_PERSON.test(opener.narration)) {
    violations.push({
      rule: "no_direct_address",
      detail: "the opening scene never addresses the listener in the second person",
    });
  }
  if (!opener.narration.includes("?")) {
    violations.push({
      rule: "no_opening_question",
      detail: "the opening scene asks the listener nothing",
    });
  }
  // The episode is the listener's story, not a story told near them, so the
  // second person has to carry the whole thing rather than decorate the hook.
  // Two separate failures, because they need different fixes:
  //
  //   - dropped entirely after the opening: a personal hook bolted onto a
  //     third-person demonstration.
  //   - present but sparse: the drift seen in production, where an episode
  //     opens on "you" and then follows a named stranger for six scenes.
  //
  // Measured outside dialogue: a character saying "you" to another character
  // is not the narrator addressing the viewer.
  const addressedScenes = substantive.filter((s) => SECOND_PERSON.test(stripDialogue(s.narration)));
  if (substantive.length > 0) {
    const coverage = addressedScenes.length / substantive.length;
    if (coverage < SECOND_PERSON_SCENE_COVERAGE) {
      violations.push({
        rule: "protagonist_not_the_listener",
        detail:
          `only ${addressedScenes.length} of ${substantive.length} scenes address the listener ` +
          `(${Math.round(coverage * 100)}%, floor ${Math.round(SECOND_PERSON_SCENE_COVERAGE * 100)}%) -- ` +
          `the episode is happening to someone else`,
      });
    }
  }

  // 9b. Name the situation, never the listener's character. Checked against
  //     the narrator's own sentences: a character in the demonstration may
  //     say "you always do this" to another character, and that is drama,
  //     not the narrator diagnosing the viewer.
  for (const scene of scenes) {
    const narratorVoice = stripDialogue(scene.narration);
    const match = CHARACTER_DIAGNOSIS.exec(narratorVoice);
    if (match) {
      violations.push({
        rule: "character_diagnosis",
        detail: `scene ${scene.index} tells the listener what they are ("${match[0].trim()}") instead of naming a situation`,
      });
    }
  }

  // 10. Exactly one discussion invitation, plus the opening address.
  //    Questions inside dialogue do not count: a character asking "Why two
  //    days?" is the episode working, not a second invitation. Counting them
  //    would flag correct scripts, which is worse than not checking at all.
  //    Two are allowed now, and exactly two: the opening address and the
  //    closing invitation. Three or more is the advert register the prompt
  //    warns about -- a script that opens on a run of questions.
  const questionCount = substantive.reduce(
    (sum, s) => sum + (stripDialogue(s.narration).match(/\?/g) ?? []).length,
    0,
  );
  const closingQuestions = substantive
    .slice(1)
    .reduce((sum, s) => sum + (stripDialogue(s.narration).match(/\?/g) ?? []).length, 0);
  if (closingQuestions === 0) {
    violations.push({ rule: "no_discussion_question", detail: "no discussion invitation after the opening address" });
  }
  if (questionCount > MAX_NARRATOR_QUESTIONS) {
    violations.push({
      rule: "multiple_questions",
      detail: `${questionCount} narrator questions (allowed ${MAX_NARRATOR_QUESTIONS}: one opening address, one discussion invitation)`,
    });
  }

  // 10-11. The outro is a short declarative bridge, replaced by the packager.
  const outro = scenes.find((s) => s.isOutro);
  if (outro) {
    if (outro.words > OUTRO_WORD_CAP) {
      violations.push({ rule: "outro_word_cap", detail: `outro runs ${outro.words} words (cap ${OUTRO_WORD_CAP})` });
    }
    if (outro.narration.includes("?")) {
      violations.push({ rule: "outro_is_question", detail: "the outro bridge is a question" });
    }
  } else {
    violations.push({ rule: "no_outro", detail: "no scene marked is_outro" });
  }

  // 12. Navigation labels become on-screen chapters.
  for (const scene of scenes) {
    if (scene.label.length > NAVIGATION_LABEL_CHAR_CAP) {
      violations.push({
        rule: "label_too_long",
        detail: `scene ${scene.index} label is ${scene.label.length} chars (cap ${NAVIGATION_LABEL_CHAR_CAP})`,
      });
    }
  }

  return { ok: violations.length === 0, violations, scenes, totalWords, substantiveWords };
}

export interface ViolationRate {
  /** Always one of the closed set above, never a free-form string. */
  rule: ViolationRule;
  scripts: number;
  occurrences: number;
}

/**
 * Violation counts across many scripts, most frequent first. Run over the
 * archive this answers, for zero model calls, how much of the prompt the model
 * actually obeys -- which decides whether those rules are worth keeping.
 */
export function summariseViolations(validations: ScriptValidation[]): ViolationRate[] {
  const byRule = new Map<ViolationRule, { scripts: number; occurrences: number }>();
  for (const validation of validations) {
    const seen = new Set<ViolationRule>();
    for (const violation of validation.violations) {
      const entry = byRule.get(violation.rule) ?? { scripts: 0, occurrences: 0 };
      entry.occurrences += 1;
      if (!seen.has(violation.rule)) {
        entry.scripts += 1;
        seen.add(violation.rule);
      }
      byRule.set(violation.rule, entry);
    }
  }
  return [...byRule.entries()]
    .map(([rule, counts]) => ({ rule, ...counts }))
    .sort((a, b) => b.scripts - a.scripts || b.occurrences - a.occurrences);
}
