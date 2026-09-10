import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

interface AgentDef {
  name: string;
  model: {
    capability: string;
    max_output_tokens?: number;
    effort?: string;
    prefer_paid_reasoning?: boolean;
    prefer_paid_on_revision?: boolean;
  };
}

function agent(file: string): AgentDef {
  return JSON.parse(readFileSync(new URL(`../agents/${file}`, import.meta.url), "utf8")) as AgentDef;
}

test("low-risk agents still request low-effort fast reasoning", () => {
  // RFC 0009 grew what these agents PRODUCE -- a 20-30 candidate package
  // tournament, three packaging propositions, causal editorial memory -- but
  // not how hard they have to think. They stay on the cheap tier and are
  // bounded by output budget instead. This pipeline runs daily, so the
  // reasoning tier is the recurring bill; moving an agent off this list is a
  // real cost decision and should be argued for, not slipped in.
  const lowRisk = [
    "discovery.json",
    "seo_optimizer.json",
    "thumbnail_designer.json",
    "channel_strategist.json",
  ];

  for (const file of lowRisk) {
    const def = agent(file);
    assert.equal(def.model.capability, "reasoning_fast", `${def.name} should use the fast capability`);
    assert.equal(def.model.effort, "low", `${def.name} should be eligible for the fast/cheap reasoning tier`);
  }
});

test("core creative agents do not request low-effort routing", () => {
  const protectedAgents = [
    "narrative_story_architect.json",
    "narration_script_writer.json",
  ];

  for (const file of protectedAgents) {
    const def = agent(file);
    assert.notEqual(def.model.effort, "low", `${def.name} should stay on the main reasoning tier`);
  }
});

test("only the watchability evaluate/revise loop reaches for the paid model", () => {
  // watchability_release thresholds (hook 0.82, avg 0.79, ...) are calibrated
  // against the strong paid critic. The free 70B chain scores the same scripts
  // lower and the free writer plateaus one dimension short over five revisions,
  // so the unattended loop cannot converge on its own.
  //
  //  - watchability_critic ALWAYS grades on the paid model when one is
  //    available (it authorizes all downstream image/render spend).
  //  - narration_script_writer's FIRST draft stays free-first; only a
  //    watchability-triggered revision writes on the paid model, because a
  //    revision exists only because the paid critic found a real deficiency.
  //
  // Every other agent, and the first script draft, stays free-first.
  const shipped = readdirSync(new URL("../agents/", import.meta.url)).filter((f) => f.endsWith(".json"));
  const alwaysPaid = shipped.filter((f) => agent(f).model.prefer_paid_reasoning === true).map((f) => agent(f).name);
  const paidOnRevision = shipped.filter((f) => agent(f).model.prefer_paid_on_revision === true).map((f) => agent(f).name);
  assert.deepEqual(alwaysPaid, ["watchability_critic"]);
  assert.deepEqual(paidOnRevision, ["narration_script_writer"]);
});

test("agent output budgets stay bounded", () => {
  const ceilings: Record<string, number> = {
    // Raised from 3000 for RFC 0009's package tournament: 20-30 candidates,
    // each carrying premise/audience/curiosity gap/titles/thumbnails/scores,
    // physically cannot serialize into 3000 output tokens. Volume, not
    // difficulty -- discovery stays on the cheap reasoning tier above.
    "discovery.json": 12000,
    // 2500 for RFC 0009 decision 8: three materially different packaging
    // propositions (curiosity / injustice / reversal), not one title plus
    // synonyms, do not fit the old single-package budget.
    "seo_optimizer.json": 2500,
    // Also 2500 for decision 8: three thumbnail concepts, one per framing
    // family, rather than a single brief.
    "thumbnail_designer.json": 2500,
    "channel_strategist.json": 5000,
    // 6500: the story now carries the package promise and first-30 beat
    // structure (decision 2) alongside the story itself.
    "narrative_story_architect.json": 6500,
    // 14000: narration now has to realize the package's three-beat first-30
    // contract, not just tell the story.
    "narration_script_writer.json": 14000,
    "watchability_critic.json": 18000,
    // growth_packager is new in RFC 0009 and must be bounded like the rest --
    // an unlisted agent would silently escape this test entirely.
    "growth_packager.json": 5000,
  };

  // Every agent the catalog ships must appear above. Without this, adding a
  // new agent is a way to opt out of the budget guardrail by omission, which
  // is exactly how discovery's 6x raise would have gone unnoticed.
  const shipped = readdirSync(new URL("../agents/", import.meta.url)).filter((f) => f.endsWith(".json"));
  assert.deepEqual(shipped.sort(), Object.keys(ceilings).sort(), "every shipped agent needs a declared output ceiling");

  for (const [file, ceiling] of Object.entries(ceilings)) {
    const def = agent(file);
    assert.ok(def.model.max_output_tokens, `${def.name} should set an explicit output ceiling`);
    assert.ok(
      def.model.max_output_tokens! <= ceiling,
      `${def.name} budget ${def.model.max_output_tokens} exceeds ${ceiling}`,
    );
  }
});

test("prompt input compression is wired into the runner", () => {
  const runner = readFileSync(new URL("../src/runner.ts", import.meta.url), "utf8");

  assert.match(runner, /promptInputView\(def\.name, name, artifact\.payload\)/);
  assert.doesNotMatch(runner, /JSON\.stringify\(artifact\.payload, null, 2\)/);
});

test("engine no longer imports the Anthropic SDK or the old compat shim", () => {
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");

  assert.doesNotMatch(pkg, /@anthropic-ai\/sdk/);
  assert.doesNotMatch(service, /providers\/anthropic\.ts/);
  assert.match(service, /providers\/openai\.ts/);
});

test("run-start preflight checks gate on the credential that is actually required", () => {
  // PR #101 moved reasoning to Ollama-only, but a hardcoded pre-flight check
  // in service.ts kept gating on ANTHROPIC_API_KEY, which docker-compose.yml
  // no longer set at all -- startRun failed unconditionally even with Ollama
  // fully configured. Reasoning has since moved to OpenAI; keep the same
  // regression class covered against whatever credential is actually
  // required now. RFC 0010 convergence made manual narration an input mode of
  // illustrated_story rather than a separate graph: a manual run still executes
  // the full production DAG (package, watchability, RFC 0010 visuals, SEO,
  // render, QA) minus story/script authoring, so startRun AND startManualRun
  // both legitimately gate on the reasoning credential.
  const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");

  assert.doesNotMatch(service, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(service, /OLLAMA_BASE_URL/);
  const matches = service.match(/OPENAI_API_KEY.*is not set/g) ?? [];
  assert.equal(matches.length, 2, "startRun and startManualRun both gate on OPENAI_API_KEY");
});
