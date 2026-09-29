/**
 * "Write it for me" for the studio's New Short form (operator decision
 * 2026-09-29): given a topic, draft a title, hook and script in the viral
 * list-Short structure (number promise, open loop, one payoff per 15-20 s,
 * named real effects, concrete actions, comment-bait close). The editor reviews
 * and submits it as a normal custom Short -- nothing here renders or publishes.
 *
 * Clickbait framing is wanted; invented facts are not. The structure and the
 * honesty rules are checked deterministically, and a failing draft is sent
 * back with the exact problems, up to MAX_ATTEMPTS times.
 *
 * Deliberately separate from narration_script_writer, which is frozen as the
 * long-form control (see script-prompt-frozen memory / RFC notes).
 */

import type { ModelProvider } from "./provider.ts";
import type { PromptStore } from "./prompts.ts";
import { FORMATS } from "./video-format.ts";
import { SPOKEN_CTA_SHORT } from "./cta.ts";

export const SHORT_DRAFT_PROMPT = "short_script_writer@1";
export const MAX_ATTEMPTS = 3;
/** The narrator's measured pace on production renders (~170 words/min). */
export const WORDS_PER_SECOND = 170 / 60;

export interface ShortDraft {
  title: string;
  alternative_titles: string[];
  hook: string;
  script: string;
}

export interface ShortDraftResult extends ShortDraft {
  /** Spoken length incl. the auto-appended CTA, at the narrator's pace. */
  estimated_seconds: number;
  attempts: number;
  /** Rules the final draft still misses (empty when it passed). */
  problems: string[];
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

/** Every structure/honesty rule the draft misses, in plain words the model can act on. */
export function shortDraftProblems(draft: ShortDraft): string[] {
  const problems: string[] = [];
  const title = draft.title?.trim() ?? "";
  const hook = draft.hook?.trim() ?? "";
  const script = draft.script?.trim() ?? "";
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  if (title.length < 20 || title.length > 100) problems.push(`title must be 20-100 characters (is ${title.length})`);
  if (words(hook) < 8 || words(hook) > 35) problems.push(`hook must be 8-35 words (is ${words(hook)})`);
  if (!NUMBER_PROMISE.test(hook)) problems.push("hook must promise a number of tricks/signs/reasons (e.g. 'three tricks')");
  if (!OPEN_LOOP.test(hook)) problems.push("hook must plant an open loop on the last item (e.g. 'the third one feels like cheating')");
  if (paragraphs.length < 3 || paragraphs.length > 6) problems.push(`script must be 2-5 item paragraphs plus a closing question, separated by blank lines (has ${paragraphs.length} paragraphs)`);
  const close = paragraphs.at(-1) ?? "";
  if (!/\?/.test(close) || words(close) > 20) problems.push("the last paragraph must be one short comment-bait question (under 20 words)");

  const everything = `${title} ${hook} ${script}`;
  if (/\d+(\.\d+)?\s?%|\bpercent\b/i.test(everything)) problems.push("remove every percentage/statistic -- no invented numbers");
  if (/\b(like and subscribe|subscribe|hit the bell|follow (me|us|for more))\b/i.test(`${hook} ${script}`)) {
    problems.push("do not ask viewers to like, subscribe or follow -- a follow line is added automatically");
  }
  if (/\bdark psychology\b/i.test(everything)) problems.push("do not frame ordinary advice as 'dark psychology'");

  const seconds = estimateSeconds(hook, script);
  const spec = FORMATS.short;
  if (seconds < spec.minDurationSec! || seconds > spec.maxDurationSec!) {
    problems.push(`spoken length must be ${spec.minDurationSec}-${spec.maxDurationSec}s; this is about ${seconds}s (${words(hook) + words(script)} words) -- ${seconds > spec.maxDurationSec! ? "cut" : "add"} roughly ${Math.abs(Math.round((seconds - (seconds > spec.maxDurationSec! ? 70 : 64)) * WORDS_PER_SECOND))} words`);
  }
  return problems;
}

export function estimateSeconds(hook: string, script: string): number {
  return Math.round((words(hook) + words(script) + words(SPOKEN_CTA_SHORT)) / WORDS_PER_SECOND);
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
): Promise<ShortDraftResult> {
  const cleanTopic = topic.trim();
  if (cleanTopic.length < 3 || cleanTopic.length > 300) throw new Error("topic must be 3-300 characters");
  let best: { draft: ShortDraft; problems: string[] } | null = null;
  let feedback = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    const prompt = deps.prompts.render(SHORT_DRAFT_PROMPT, { topic: cleanTopic, feedback });
    const result = await deps.provider.complete({
      prompt,
      outputSchema: SHORT_DRAFT_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 4000,
      effort: "medium",
      preferPaidReasoning: true,
    });
    const draft = asDraft(result.value);
    const problems = shortDraftProblems(draft);
    if (!best || problems.length < best.problems.length) best = { draft, problems };
    if (problems.length === 0) break;
    feedback = `YOUR PREVIOUS DRAFT BROKE THESE RULES -- fix every one and return a complete new draft:\n- ${problems.join("\n- ")}\n\nPrevious draft:\n${JSON.stringify(draft)}`;
  }
  const { draft, problems } = best!;
  return {
    ...draft,
    estimated_seconds: estimateSeconds(draft.hook, draft.script),
    attempts,
    problems,
  };
}
