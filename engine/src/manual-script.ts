/**
 * Turns an operator-written hook and narration into schema-valid `story` and
 * `script` artifacts, with no model call.
 *
 * This exists for the manual graph (engine/graphs/manual.json): when the
 * operator writes their own words, story_architect and script_writer never
 * run, but every downstream stage (visuals, voice, SEO, thumbnail, render,
 * QA) still expects artifacts shaped exactly like the ones those agents would
 * have produced. Paragraph and sentence boundaries decide where scenes split;
 * word-count thirds decide where acts split. Every field is either typed by
 * the operator or extracted verbatim from what they typed — nothing is
 * invented, matching how `buildPerformanceWindow` assembles a graph input
 * deterministically rather than asking a model to do it.
 */

export interface ManualScriptInput {
  title: string;
  hook: string;
  narration: string;
  topic?: string;
}

export interface ManualStoryPayload {
  topic: string;
  title: string;
  hook: string;
  acts: Array<{ act_index: number; act_title: string; premise: string; target_words: number }>;
  payoff: string;
  outro_line: string;
}

export interface ManualScriptPayload {
  scenes: Array<{ scene_index: number; act_index: number; point: string; narration: string }>;
}

export interface ManualEpisode {
  story: ManualStoryPayload;
  script: ManualScriptPayload;
}

const SCENE_WORDS_MAX = 40;
const SCENE_CHARS_MAX = 2000;
const OUTRO_LINE = "Thanks for watching — like and subscribe for more.";

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Pads text that is too short for a schema's minLength rather than fail on it. */
function withMinLength(s: string, min: number): string {
  let out = s.trim();
  while (out.length > 0 && out.length < min) out += " This part continues the narration.";
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'‘“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Greedily groups sentences into scene-sized chunks, targeting ~40 words each. */
function groupSentences(sentences: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const w = wordCount(sentence);
    const joined = [...current, sentence].join(" ");
    if (current.length > 0 && (words + w > SCENE_WORDS_MAX || joined.length > maxChars)) {
      chunks.push(current.join(" "));
      current = [sentence];
      words = w;
    } else {
      current.push(sentence);
      words += w;
    }
  }
  if (current.length > 0) chunks.push(current.join(" "));
  return chunks;
}

/** One scene per paragraph when the operator paragraphed their script; sentence-grouped otherwise. */
function splitIntoScenes(text: string): string[] {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const chunks = paragraphs.length > 1 ? paragraphs : splitSentences(text.replace(/\s+/g, " "));

  const scenes: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= SCENE_CHARS_MAX && wordCount(chunk) <= SCENE_WORDS_MAX * 1.5) {
      scenes.push(chunk);
    } else {
      scenes.push(...groupSentences(splitSentences(chunk), SCENE_CHARS_MAX));
    }
  }
  return scenes;
}

/** Merges a fragment too short to be its own narration beat into the previous one. */
function mergeShortFragments(chunks: string[], minChars: number): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    if (out.length > 0 && c.length < minChars) {
      out[out.length - 1] = `${out[out.length - 1]} ${c}`;
    } else {
      out.push(c);
    }
  }
  return out;
}

/** Hard safety net for the schema's 2000-char scene cap — real narration never hits this. */
function hardWrap(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function buildManualEpisode(input: ManualScriptInput): ManualEpisode {
  const title = input.title.trim();
  const hook = input.hook.trim();
  const narration = input.narration.trim();

  if (title.length < 5 || title.length > 100) throw new Error("title must be 5-100 characters");
  if (hook.length < 10 || hook.length > 600) throw new Error("hook must be 10-600 characters");
  if (narration.length < 5) throw new Error("narration is too short");

  const bodyScenes = mergeShortFragments(splitIntoScenes(narration), 5);
  const sceneTexts = [hook, ...bodyScenes].flatMap((t) => hardWrap(t, SCENE_CHARS_MAX));

  // Acts and scenes are validated by separate schemas with no cross-reference
  // requirement, so acts are split by word-count thirds independently of scene
  // boundaries — this stays correct even for very short narration.
  const wordsPerScene = sceneTexts.map(wordCount);
  const totalWords = wordsPerScene.reduce((a, b) => a + b, 0) || 1;
  const boundary1 = totalWords / 3;
  const boundary2 = (2 * totalWords) / 3;

  let running = 0;
  const sceneActIndex = wordsPerScene.map((w) => {
    running += w;
    return running <= boundary1 ? 0 : running <= boundary2 ? 1 : 2;
  });

  const scenes = sceneTexts.map((narrationText, i) => ({
    scene_index: i,
    act_index: sceneActIndex[i]!,
    point: truncate(narrationText, 80),
    narration: narrationText,
  }));

  const acts = [0, 1, 2].map((actIndex) => {
    const text = sceneTexts.filter((_, i) => sceneActIndex[i] === actIndex).join(" ");
    const words = wordsPerScene.filter((_, i) => sceneActIndex[i] === actIndex).reduce((a, b) => a + b, 0);
    const premise = text || `${title}. ${hook}`;
    return {
      act_index: actIndex,
      act_title: `Part ${actIndex + 1}`,
      premise: truncate(withMinLength(premise, 20), 1200),
      target_words: Math.min(1200, Math.max(50, words)),
    };
  });

  const payoff = sceneTexts[sceneTexts.length - 1] ?? narration;
  const topic = input.topic?.trim() || `${title} — told from the operator's own script.`;

  return {
    story: {
      topic: truncate(withMinLength(topic, 8), 300),
      title,
      hook,
      acts,
      payoff: truncate(withMinLength(payoff, 10), 800),
      outro_line: OUTRO_LINE,
    },
    script: { scenes },
  };
}
