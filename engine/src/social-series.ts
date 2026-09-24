/** Versioned editorial plan. Explicit selection never substitutes a trending topic. */
export const SOCIAL_SERIES_ID = "everyday-psychology-v1";
const episodes = [
  ["Why One Unanswered Text Ruins Your Evening", "Notice when you fill a silence with the worst explanation", "A friend reads your message and doesn't reply", "List three ordinary explanations before you react"],
  ["Reading a Tone That Isn't There", "Separate the words someone wrote from the tone you added", "A short work email feels cold", "Reread one message aloud in a neutral voice before replying"],
  ["Why You Keep Paying for Things You Don't Enjoy", "Decide on what's ahead, not on what's already spent", "Staying at a bad event because the ticket was expensive", "Ask once this week: would I choose this today from scratch?"],
  ["Putting It Off Isn't Laziness", "Treat procrastination as avoiding a feeling and shrink the first step", "An important form avoided for weeks", "Spend two minutes on one task you've been avoiding"],
  ["The Spotlight Is Smaller Than You Think", "Estimate how much other people actually noticed", "Stumbling over your words in a meeting", "Afterwards, ask one person what they remember"],
  ["When the First Number Decides for You", "Set your own reference point before you see someone else's", "Haggling over a secondhand car", "Write down your number before you look at the price"],
  ["Why Everyone Else Seems to Have It Together", "Compare like with like, not your inside with their outside", "Scrolling past a friend's big news after a bad day", "Name one thing you'd need to know before comparing"],
  ["Changing Your Mind Without Losing Face", "Update a view when the facts change, and say so", "Defending a choice in a family argument after learning you were wrong", "Practise one sentence: 'I've looked again, and I think I was wrong about...'"],
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
    series_title: "Second Thoughts",
    title: row[0],
    learning_objective: row[1],
    scenario: row[2],
    exercise: row[3],
    prior_skills: episodes.slice(0, episode - 1).map(e => e[1]),
    next_episode_title: episodes[episode]?.[0] ?? null,
    audience: "English-speaking adults curious about why they think and react the way they do",
    format: "Audio-first scenario lesson; fictional examples clearly labelled; not therapy, diagnosis or invented research",
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
