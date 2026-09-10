import { test } from "node:test";
import assert from "node:assert/strict";
import { socialSeriesCatalog, socialSeriesEpisode, socialSeriesScriptErrors } from "../src/social-series.ts";

test("season contains eight distinct objectives and exact sequential bridges", () => {
  const episodes = socialSeriesCatalog();
  assert.equal(new Set(episodes.map(e => e.learning_objective)).size, 8);
  episodes.forEach((e, i) => {
    assert.equal(e.episode, i + 1);
    assert.equal(e.prior_skills.length, i);
    assert.equal(e.next_episode_title, episodes[i + 1]?.title ?? null);
  });
});
test("invalid episode selection cannot silently choose another topic", () => {
  for (const n of [0, -1, 9, 1.5, NaN, Infinity]) assert.throws(() => socialSeriesEpisode(n));
});
test("script requires all educational functions rather than generic drama", () => {
  assert.equal(socialSeriesScriptErrors({ scenes: [] }).length, 7);
  const scenes = ["scenario", "response_a", "response_b", "explanation", "limitations", "exercise", "payoff"].map(t => ({point: `[${t}] purposeful beat`, narration: "Imagine a colleague asks a question.", is_outro: false}));
  scenes.push({point: "closing", narration: "Take this into your next conversation.", is_outro: true});
  assert.deepEqual(socialSeriesScriptErrors({ scenes }), []);
  assert.equal(socialSeriesScriptErrors({ scenes: scenes.filter(s => !s.point.startsWith("[payoff]")) }).length, 1);
  assert.match(socialSeriesScriptErrors({scenes: scenes.map((s,i)=>i===0?{...s,narration:"Background ".repeat(91)}:s)}).join(" "), /90 words/);
  assert.match(socialSeriesScriptErrors({scenes: scenes.map((s,i)=>i===0?{...s,narration:"Welcome back to the channel."}:s)}).join(" "), /generic introduction/);
  assert.match(socialSeriesScriptErrors({scenes: scenes.map(s=>({...s,narration:s.point}))}).join(" "), /leak/);
  assert.match(socialSeriesScriptErrors({scenes: scenes.map(s=>({...s,narration:""}))}).join(" "), /spoken content/);
  assert.match(socialSeriesScriptErrors({scenes: scenes.slice(0,-1).map((s,i)=>({...s,is_outro:i===6}))}).join(" "), /overwrite/);
});
