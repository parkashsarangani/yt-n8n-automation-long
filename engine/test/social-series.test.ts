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
  const scenes = ["scenario", "response_a", "response_b", "explanation", "limitations", "exercise", "payoff"].map(t => ({point: `[${t}] purposeful beat`}));
  assert.deepEqual(socialSeriesScriptErrors({ scenes }), []);
  assert.equal(socialSeriesScriptErrors({ scenes: scenes.slice(0, -1) }).length, 1);
});
