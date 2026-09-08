/**
 * Turns an operator-written hook and narration into schema-valid `story` and
 * `script` artifacts, with no model call.
 *
 * This backs the manual input mode of illustrated_story (its `package`, `story`
 * and `draft_script` nodes get preset outputs): when the operator writes their
 * own words, growth_packager, story_architect and script_writer never run, but
 * every downstream stage (watchability, visuals, voice, SEO, thumbnail, render,
 * QA) still expects artifacts shaped exactly like the ones those agents would
 * have produced. Paragraph and sentence boundaries decide where scenes split;
 * word-count thirds decide where acts split. The story/script are the
 * operator's verbatim words; the growth_package's scored fields (premise,
 * curiosity gap, first-30 milestones, opening line, selected title/thumbnail)
 * are also taken from the operator's hook and opening scenes, with only the
 * two non-selected variant slots filled by structural placeholders so the
 * exact-membership contract holds. No model is in the loop.
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

export interface ManualGrowthVariant {
  family: "curiosity" | "conflict" | "reversal";
  title: string;
  thumbnail_concept: string;
  click_reason: string;
}

export interface ManualGrowthPackagePayload {
  premise: string;
  target_audience: string;
  curiosity_gap: string;
  emotional_engine: string;
  selected_title: string;
  selected_title_family: "curiosity";
  selected_thumbnail_concept: string;
  selected_thumbnail_family: "curiosity";
  opening_visual: string;
  opening_line: string;
  first_30_seconds: {
    promise: string;
    zero_to_five: string;
    five_to_fifteen: string;
    fifteen_to_thirty: string;
  };
  variants: ManualGrowthVariant[];
  scores: { clickability: number; story_potential: number; audience_size: number };
  selection_rationale: string;
  next_video_bridge: string;
}

export interface ManualEpisode {
  story: ManualStoryPayload;
  script: ManualScriptPayload;
  /**
   * The operator owns the click proposition too, not just the words. Without
   * this, growth_packager invents a package from the bare title and
   * watchability then (correctly) scores the operator's fixed script against a
   * promise it never made — package_fidelity / first_30_fidelity collapse. The
   * package is derived from the operator's own hook + opening narration so the
   * script and the promise describe the same episode.
   */
  growth_package: ManualGrowthPackagePayload;
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
    growth_package: buildManualGrowthPackage(title, hook, sceneTexts, payoff, input.topic),
  };
}

const FAMILY_MIN = 8;

/**
 * Derive a schema- and contract-valid growth_package from the operator's own
 * words. The operator's title/thumbnail are the authoritative curiosity
 * variant (selected); the conflict/reversal variants are structural
 * placeholders — valid, distinct, never selected — so the exact-membership
 * contract in growth-package-contract.ts holds. Every promise the critic
 * scores against (premise, curiosity_gap, first_30 milestones, opening line)
 * is taken from the operator's hook and opening scenes, so the fixed script
 * and the package describe the same episode.
 */
export function buildManualGrowthPackage(
  title: string,
  hook: string,
  sceneTexts: string[],
  payoff: string,
  topic?: string,
): ManualGrowthPackagePayload {
  const hookSentences = splitSentences(hook);
  const openingLine = truncate(withMinLength(hookSentences[0] ?? hook, FAMILY_MIN), 220);
  const body = sceneTexts.slice(1); // sceneTexts[0] is the hook itself
  // First sentence of a scene keeps the milestone fields well under their caps.
  const beat = (i: number): string => {
    const source = body[i] ?? body[body.length - 1] ?? hook;
    return withMinLength(splitSentences(source)[0] ?? source, FAMILY_MIN);
  };

  const selectedTitle = truncate(withMinLength(title, FAMILY_MIN), 100);
  const selectedThumb = truncate(
    withMinLength(`A grounded, realistic depiction of the opening moment: ${openingLine}`, 12),
    260,
  );

  const variants: ManualGrowthVariant[] = [
    {
      family: "curiosity",
      title: selectedTitle,
      thumbnail_concept: selectedThumb,
      click_reason: "The title poses the concrete unanswered question the narration goes on to answer.",
    },
    {
      family: "conflict",
      title: withMinLength(`Nobody Believed What ${truncate(title, 48)} Uncovered`, FAMILY_MIN),
      thumbnail_concept: "The operator-authored script is fixed; this framing is a structural alternate and is not used.",
      click_reason: "Structural alternate framing for the required variant set; not the selected proposition.",
    },
    {
      family: "reversal",
      title: withMinLength(`${truncate(title, 52)} Was Not What It Looked Like`, FAMILY_MIN),
      thumbnail_concept: "The operator-authored script is fixed; this framing is a structural alternate and is not used.",
      click_reason: "Structural alternate framing for the required variant set; not the selected proposition.",
    },
  ];

  return {
    premise: truncate(withMinLength(`${beat(0)} ${beat(1)}`.trim(), 15), 400),
    target_audience: "Adults who follow grounded, true-to-life mystery, investigation and workplace stories.",
    curiosity_gap: truncate(withMinLength(hookSentences.slice(-1)[0] ?? hook, FAMILY_MIN), 240),
    emotional_engine: "curiosity to unease to a concrete, human resolution",
    selected_title: selectedTitle,
    selected_title_family: "curiosity",
    selected_thumbnail_concept: selectedThumb,
    selected_thumbnail_family: "curiosity",
    opening_visual: truncate(withMinLength(`A grounded, realistic scene: ${openingLine}`, 12), 320),
    opening_line: truncate(openingLine, 220),
    first_30_seconds: {
      promise: truncate(withMinLength(`The episode answers this in full: ${openingLine}`, 12), 220),
      zero_to_five: truncate(beat(0), 260),
      five_to_fifteen: truncate(beat(1), 260),
      fifteen_to_thirty: truncate(beat(2), 260),
    },
    variants,
    scores: { clickability: 0.8, story_potential: 0.8, audience_size: 0.75 },
    selection_rationale: truncate(
      "Operator-authored package: the curiosity framing states the concrete unanswered question the operator's narration answers, and the first-30 milestones are the operator's own opening scenes.",
      500,
    ),
    next_video_bridge: truncate(
      withMinLength(
        topic?.trim()
          ? `Next: another case that began the same quiet way — ${topic.trim()}`
          : "Next: another quiet worker who noticed the one detail everyone else was trained to ignore.",
        15,
      ),
      220,
    ),
  };
}
