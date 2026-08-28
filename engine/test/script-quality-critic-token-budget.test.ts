import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Production evidence: script_quality_critic was pinned to max_output_tokens
// 5000 while every other high-effort reasoning_high agent in this pipeline --
// including script_quality_reviser, its sibling in the exact same
// quality-release chain, reading the same story/script/cast_roster inputs --
// sits at 18000+. A real 64-scene episode hit "openai/gpt-5.6-luna hit
// max_tokens (5000); output is truncated" on the critic specifically,
// blocking the run with no path forward except raising the budget: a
// high-effort model's own reasoning tokens count against this limit, and an
// 11-dimension confidence report with evidence citations over a long script
// genuinely needs the room its sibling agents already get.
const critic = JSON.parse(
  readFileSync(new URL("../agents/script_quality_critic.json", import.meta.url), "utf8"),
);
const reviser = JSON.parse(
  readFileSync(new URL("../agents/script_quality_reviser.json", import.meta.url), "utf8"),
);

test("script_quality_critic's token budget is not tighter than its sibling reviser's", () => {
  assert.ok(
    critic.model.max_output_tokens >= reviser.model.max_output_tokens,
    `critic budget ${critic.model.max_output_tokens} is tighter than reviser budget ${reviser.model.max_output_tokens}, ` +
      `despite both reasoning over the same story/script/cast_roster inputs at the same "high" effort`,
  );
  assert.ok(
    critic.model.max_output_tokens >= 18000,
    "a high-effort critic evaluating a full episode script needs real room for reasoning tokens plus an 11-dimension report",
  );
});
