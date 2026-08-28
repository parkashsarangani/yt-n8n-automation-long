import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Production evidence: script_quality_critic was pinned to max_output_tokens
// 5000 while every other high-effort reasoning_high agent in this pipeline
// sits at 18000+. A real 64-scene episode hit "openai/gpt-5.6-luna hit
// max_tokens (5000); output is truncated" on the critic specifically,
// blocking the run with no path forward except raising the budget: a
// high-effort model's own reasoning tokens count against this limit, and an
// 11-dimension confidence report with evidence citations over a long script
// genuinely needs the room its sibling agents already get. Raised to 18000.
//
// script_quality_reviser hit the same wall at its own 18000 ceiling on a
// later run: unlike the critic (which only emits a compact score report),
// the reviser has to emit a full REVISED script -- the same order of
// magnitude of output as dialogue_script_writer's own 18000-token budget --
// plus its reasoning about the critique, for the same 64-scene episode.
// Raised to 24000, matching cartoon_creative_director's tier (another
// high-effort agent producing full-episode-scale output). The two budgets
// are deliberately NOT required to match each other: the reviser's larger
// output is structurally expected to need more room than the critic's.
const critic = JSON.parse(
  readFileSync(new URL("../agents/script_quality_critic.json", import.meta.url), "utf8"),
);
const reviser = JSON.parse(
  readFileSync(new URL("../agents/script_quality_reviser.json", import.meta.url), "utf8"),
);

test("script_quality_critic and script_quality_reviser both have real room for a full-episode pass", () => {
  assert.ok(
    critic.model.max_output_tokens >= 18000,
    "a high-effort critic evaluating a full episode script needs real room for reasoning tokens plus an 11-dimension report",
  );
  assert.ok(
    reviser.model.max_output_tokens >= 24000,
    "a high-effort reviser re-emitting a full episode script (plus its own reasoning) needs more room than a compact score report does",
  );
});
