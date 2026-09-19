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
  | "label_too_long";

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

  // 9. Exactly one discussion invitation, and never a second closing question.
  //    Questions inside dialogue do not count: a character asking "Why two
  //    days?" is the episode working, not a second invitation. Counting them
  //    would flag correct scripts, which is worse than not checking at all.
  const questionCount = substantive.reduce(
    (sum, s) => sum + (stripDialogue(s.narration).match(/\?/g) ?? []).length,
    0,
  );
  if (questionCount === 0) {
    violations.push({ rule: "no_discussion_question", detail: "no discussion invitation found" });
  } else if (questionCount > 1) {
    violations.push({
      rule: "multiple_questions",
      detail: `${questionCount} question marks in substantive narration (expected exactly 1)`,
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
