/** Versioned editorial plan. Explicit selection never substitutes a trending topic. */
export const SOCIAL_SERIES_ID = "quiet-confidence-v1";
const episodes = [
  ["Entering a Room Where You Know Nobody", "Approach one person without performing", "Arriving alone at a gathering", "Ask one context-based opening question"],
  ["Starting a Conversation Without Sounding Rehearsed", "Use context, curiosity and a little self-disclosure", "Meeting a new colleague", "Try an observation followed by an open question"],
  ["Keeping a Conversation Interesting Without Interrogating", "Balance questions, listening and sharing", "A conversation becomes a string of questions", "Share one relevant detail before asking another question"],
  ["Showing Interest Without Applying Pressure", "Express interest and recognise reciprocity without mind-reading", "A friendly conversation might be a romantic connection", "Practise one specific, low-pressure invitation; accept a no"],
  ["Responding When Someone Interrupts or Dismisses You", "Reclaim a turn without escalating unnecessarily", "A colleague repeatedly talks over you", "Practise a brief request to finish your point"],
  ["Saying No Without a Long Defence", "Set a clear boundary with context-sensitive alternatives", "Someone asks for another favour you cannot take on", "Write a concise refusal without inventing an excuse"],
  ["Handling Rejection Without Chasing Approval", "Separate disappointment from entitlement and self-worth", "An invitation is declined", "Practise accepting the answer without bargaining"],
  ["Having the Conversation You Have Been Avoiding", "Combine clarity, listening, boundaries and a concrete request", "An unresolved disagreement with a friend", "Prepare an observation, its impact, a question and a request"],
] as const;

export function socialSeriesEpisode(episode: number) {
  if (!Number.isInteger(episode) || episode < 1 || episode > episodes.length) {
    throw new Error("episode must be an integer from 1 to 8");
  }
  const row = episodes[episode - 1]!;
  return {
    series_id: SOCIAL_SERIES_ID,
    season: 1,
    episode,
    total_episodes: episodes.length,
    series_title: "Quiet Confidence",
    title: row[0],
    learning_objective: row[1],
    scenario: row[2],
    exercise: row[3],
    prior_skills: episodes.slice(0, episode - 1).map(e => e[1]),
    next_episode_title: episodes[episode]?.[0] ?? null,
    audience: "English-speaking adults seeking practical social confidence",
    format: "Audio-first scenario lesson; fictional examples clearly labelled; not therapy or mind-reading",
  };
}

export function socialSeriesCatalog() {
  return episodes.map((_, i) => socialSeriesEpisode(i + 1));
}

/** Mechanical structure only; the critic must assess actual quality and usefulness. */
export function socialSeriesScriptErrors(payload: unknown): string[] {
  const scenes = (payload as { scenes?: { point?: string; narration?: string; is_outro?: boolean }[] } | null)?.scenes;
  if (!Array.isArray(scenes)) return ["series script requires scenes"];
  const points = scenes.map(s => String(s?.point ?? "").toLowerCase());
  const errors = ["scenario", "response_a", "response_b", "explanation", "limitations", "exercise", "payoff"]
    .filter(tag => !points.some(p => p.startsWith(`[${tag}]`)))
    .map(tag => `series script requires a [${tag}] scene point`);
  if (!scenes.length) return errors;
  const spoken = scenes.map(s => String(s?.narration ?? "").trim());
  if (!points[0]?.startsWith("[scenario]")) errors.push("series script must open inside the scenario");
  if (spoken.some(s => !s)) errors.push("series scene labels require spoken content");
  if (spoken.some(s => /\[(scenario|response_a|response_b|explanation|limitations|exercise|payoff)\]/i.test(s))) {
    errors.push("planning labels must not leak into narration");
  }
  if (/^(?:hello everyone|hey (?:everyone|guys)|welcome (?:back|to)|in (?:this|today's) (?:video|episode))\b/i.test(spoken[0]!)) {
    errors.push("opening starts with a generic introduction instead of the scenario");
  }
  const firstResponse = points.findIndex(p => /^\[response_[ab]\]/.test(p));
  const leadWords = spoken.slice(0, firstResponse).join(" ").trim().split(/\s+/).filter(Boolean).length;
  if (firstResponse > 0 && leadWords > 90) errors.push("first concrete response starts after 90 words; move useful progress earlier");
  const payoff = points.findIndex(p => p.startsWith("[payoff]"));
  const outro = scenes.findIndex(s => s?.is_outro === true);
  if (outro < 0 || outro !== scenes.length - 1 || scenes.filter(s => s?.is_outro).length !== 1) {
    errors.push("series requires exactly one separate final outro");
  }
  if (payoff >= 0 && outro >= 0 && payoff >= outro) errors.push("payoff must precede outro so release cannot overwrite it");
  return errors;
}
