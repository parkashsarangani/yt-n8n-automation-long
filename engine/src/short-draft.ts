/**
 * "Write it for me" for the studio's New Short form (operator decision
 * 2026-09-29): given a topic, draft a title, hook and script in a viral Short
 * structure. The editor reviews and submits it as a normal custom Short --
 * nothing here renders or publishes.
 *
 * Council review (2026-09-29) before merge: the list structure came from ONE
 * 3.7M-view Short, so it is a first guess, not a proven formula. Hence:
 * - three hook shapes (list / myth-bust / everyday moment) so every Short is
 *   not "3 tricks... the third one...";
 * - only HONESTY and LENGTH are hard rules that trigger a rewrite; structure
 *   (number promise, open loop, closing question) is returned as warnings the
 *   editor may ignore;
 * - runs made from a draft are tagged (script_source) so retention can be
 *   compared against hand-written Shorts before any rule is hardened.
 *
 * Clickbait framing is wanted; invented facts are not. Deliberately separate
 * from narration_script_writer, which is frozen as the long-form control.
 */

import type { ModelProvider } from "./provider.ts";
import type { PromptStore } from "./prompts.ts";
import { FORMATS } from "./video-format.ts";
import { SPOKEN_CTA_SHORT } from "./cta.ts";

/**
 * v2 (operator 2026-10-02: "the sole focus is on views ... solid beats that
 * translate into views and watch time"): 6-9 short beats of 15-30 words,
 * each one drawable moment (one beat = one illustrated scene), a <=12-word
 * scroll-stopping first sentence, re-hooks, escalation, and a closing line
 * that loops back to the hook. v1 wrote 3-5 paragraphs of ~20 s each.
 */
export const SHORT_DRAFT_PROMPT = "short_script_writer@2";
/** Beats after the hook, not counting the closing line. */
export const MIN_BEATS = 6, MAX_BEATS = 9;
/** Words per beat: the target range, and the point a beat must be split. */
export const BEAT_WORDS_TARGET = 30, BEAT_WORDS_MAX = 45;
export const MAX_ATTEMPTS = 3;
/** Measured on this narrator in production: ~200 words rendered at 70.8 s (~170 wpm). */
export const WORDS_PER_SECOND = 170 / 60;

export type HookShape = "list" | "myth" | "moment";
export const HOOK_SHAPES: HookShape[] = ["list", "myth", "moment"];

const SHAPE_RULES: Record<HookShape, string> = {
  list: `LIST SHORT. Hook: a pattern break -- a short, surprising claim that reframes the viewer's problem ("Your brain isn't lazy. It's scared.") -- then promise a NUMBER of tricks/signs/reasons (three is best) and plant an OPEN LOOP on the last one ("the third one feels like cheating"). Beats: each item gets TWO beats -- first the moment it fixes, shown concretely ("You open the laptop. Then the phone. Then the fridge."), then the trick itself, named plainly ("Trick one: the two-minute start.") with exactly what to do. Re-hook between items. The last item pays off the open loop and is the strongest.`,
  myth: `MYTH-BUST SHORT. Hook: state the common belief the viewer holds, then flatly say it's wrong ("You've been told procrastination is laziness. It isn't.") and promise what is really going on. Beats: show the belief in action (1-2 beats) -> the twist: what actually happens and the real effect behind it (2-3 beats, with a re-hook) -> what to do instead, concretely (2-3 beats), building to the most useful point last.`,
  moment: `EVERYDAY-MOMENT SHORT. Hook: drop the viewer into a specific, familiar moment in second person, present tense ("It's 11 p.m. You're replaying something you said at lunch.") and promise to explain why it happens. Beats: play the moment out step by step (2-3 beats) -> what is going on in their head and the real effect behind it (2-3 beats, with a re-hook) -> one concrete thing to do next time, shown in the same setting (2 beats).`,
};

export interface ShortDraft {
  title: string;
  alternative_titles: string[];
  hook: string;
  script: string;
}

export interface ShortDraftResult extends ShortDraft {
  shape: HookShape;
  /** Spoken length incl. the auto-appended CTA, at the narrator's pace. */
  estimated_seconds: number;
  attempts: number;
  /** Hard rules (honesty, length, form) the final draft still breaks -- fix before creating. */
  problems: string[];
  /** Structure suggestions it misses -- the editor's call. */
  warnings: string[];
}

export const SHORT_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "alternative_titles", "hook", "script"],
  properties: {
    title: { type: "string" },
    alternative_titles: { type: "array", items: { type: "string" } },
    hook: { type: "string" },
    script: { type: "string" },
  },
} as const;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const NUMBER_PROMISE = /\b(two|three|four|five|2|3|4|5)\b/i;
const OPEN_LOOP = /\b(third|last|final|fourth|fifth|number (three|four|five))\b/i;

export function estimateSeconds(hook: string, script: string): number {
  return Math.round((words(hook) + words(script) + words(SPOKEN_CTA_SHORT)) / WORDS_PER_SECOND);
}

/**
 * blocking: honesty, length and basic form -- a draft breaking these is
 * rewritten. warnings: structure suggestions for the chosen shape.
 */
export function shortDraftChecks(draft: ShortDraft, shape: HookShape = "list"): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const title = draft.title?.trim() ?? "";
  const hook = draft.hook?.trim() ?? "";
  const script = draft.script?.trim() ?? "";
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  // Honesty (hard).
  const everything = `${title} ${hook} ${script}`;
  if (/\d+(\.\d+)?\s?%|\bpercent\b/i.test(everything)) blocking.push("remove every percentage/statistic -- no invented numbers");
  if (/\b(like and subscribe|subscribe|hit the bell|follow (me|us|for more))\b/i.test(`${hook} ${script}`)) {
    blocking.push("do not ask viewers to like, subscribe or follow -- a follow line is added automatically");
  }
  if (/\bdark psychology\b/i.test(everything)) blocking.push("do not frame ordinary advice as 'dark psychology'");

  // Length and basic form (hard).
  if (title.length < 20 || title.length > 100) blocking.push(`title must be 20-100 characters (is ${title.length})`);
  if (words(hook) < 8 || words(hook) > 35) blocking.push(`hook must be 8-35 words (is ${words(hook)})`);
  // Each paragraph is one illustrated scene: a few long ones mean few, slow
  // picture changes -- the pacing that loses a Short's viewers.
  if (paragraphs.length < MIN_BEATS + 1 || paragraphs.length > MAX_BEATS + 1) {
    blocking.push(`script must be ${MIN_BEATS}-${MAX_BEATS} short beats plus a closing line, separated by blank lines (has ${paragraphs.length} paragraphs)`);
  }
  paragraphs.forEach((p, i) => {
    if (words(p) > BEAT_WORDS_MAX) blocking.push(`beat ${i + 1} is ${words(p)} words -- split it into beats of 15-${BEAT_WORDS_TARGET} words`);
  });
  const seconds = estimateSeconds(hook, script);
  const spec = FORMATS.short;
  if (seconds < spec.minDurationSec! || seconds > spec.maxDurationSec!) {
    const over = seconds > spec.maxDurationSec!;
    blocking.push(`spoken length must be ${spec.minDurationSec}-${spec.maxDurationSec}s; this is about ${seconds}s (${words(hook) + words(script)} words) -- ${over ? "cut" : "add"} roughly ${Math.abs(Math.round((seconds - (over ? 70 : 64)) * WORDS_PER_SECOND))} words`);
  }

  // Structure (soft) -- a first guess from one viral Short, not a proven formula.
  const close = paragraphs.at(-1) ?? "";
  if (!/\?/.test(close) || words(close) > 20) warnings.push("the last paragraph is usually one short question viewers can answer in the comments");
  const firstSentence = hook.split(/(?<=[.!?])\s+/)[0] ?? "";
  if (words(firstSentence) > 12) warnings.push(`the hook's first sentence is ${words(firstSentence)} words -- 12 or fewer stops the scroll`);
  const long = paragraphs.slice(0, -1).map((p, i) => [i + 1, words(p)] as const).filter(([, n]) => n > BEAT_WORDS_TARGET && n <= BEAT_WORDS_MAX);
  if (long.length) warnings.push(`beat${long.length > 1 ? "s" : ""} ${long.map(([i]) => i).join(", ")} run past ${BEAT_WORDS_TARGET} words -- shorter beats keep the pictures changing`);
  if (shape === "list") {
    if (!NUMBER_PROMISE.test(hook)) warnings.push("a list hook usually promises a number (e.g. 'three tricks')");
    if (!OPEN_LOOP.test(hook)) warnings.push("a list hook usually teases the last item (e.g. 'the third one feels like cheating')");
  }
  return { blocking, warnings };
}

function asDraft(value: unknown): ShortDraft {
  const v = (value ?? {}) as Partial<ShortDraft>;
  return {
    title: String(v.title ?? "").trim(),
    alternative_titles: Array.isArray(v.alternative_titles) ? v.alternative_titles.map(String).slice(0, 3) : [],
    hook: String(v.hook ?? "").trim(),
    script: String(v.script ?? "").trim(),
  };
}

export async function draftShort(
  topic: string,
  deps: { provider: ModelProvider; prompts: PromptStore },
  shape: HookShape = "list",
): Promise<ShortDraftResult> {
  const cleanTopic = topic.trim();
  if (cleanTopic.length < 3 || cleanTopic.length > 300) throw new Error("topic must be 3-300 characters");
  if (!HOOK_SHAPES.includes(shape)) throw new Error(`shape must be one of ${HOOK_SHAPES.join(", ")}`);
  let best: { draft: ShortDraft; blocking: string[]; warnings: string[] } | null = null;
  let feedback = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    const prompt = deps.prompts.render(SHORT_DRAFT_PROMPT, { topic: cleanTopic, shape_rules: SHAPE_RULES[shape], feedback });
    const result = await deps.provider.complete({
      prompt,
      outputSchema: SHORT_DRAFT_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 4000,
      effort: "medium",
      preferPaidReasoning: true,
    });
    const draft = asDraft(result.value);
    const { blocking, warnings } = shortDraftChecks(draft, shape);
    if (!best || blocking.length < best.blocking.length) best = { draft, blocking, warnings };
    // Only hard rules are worth another model call; structure is the editor's call.
    if (blocking.length === 0) break;
    feedback = `YOUR PREVIOUS DRAFT BROKE THESE RULES -- fix every one and return a complete new draft:\n- ${blocking.join("\n- ")}\n\nPrevious draft:\n${JSON.stringify(draft)}`;
  }
  const { draft, blocking, warnings } = best!;
  return { ...draft, shape, estimated_seconds: estimateSeconds(draft.hook, draft.script), attempts, problems: blocking, warnings };
}
