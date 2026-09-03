import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface AgentDef {
  name: string;
  model: {
    capability: string;
    max_output_tokens?: number;
    effort?: string;
  };
}

function agent(file: string): AgentDef {
  return JSON.parse(readFileSync(new URL(`../agents/${file}`, import.meta.url), "utf8")) as AgentDef;
}

test("low-risk agents still request low-effort fast reasoning", () => {
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
    "episode_director.json",
    "visual_planner.json",
  ];

  for (const file of protectedAgents) {
    const def = agent(file);
    assert.notEqual(def.model.effort, "low", `${def.name} should stay on the main reasoning tier`);
  }
});

test("agent output budgets stay bounded", () => {
  const ceilings: Record<string, number> = {
    "discovery.json": 3000,
    "seo_optimizer.json": 2000,
    "thumbnail_designer.json": 2000,
    "channel_strategist.json": 3000,
    "narrative_story_architect.json": 5000,
    "narration_script_writer.json": 12000,
    "episode_director.json": 10000,
    "watchability_critic.json": 6000,
    "visual_planner.json": 10000,
  };

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
  // required now. RFC 0008 retired the separate startCartoonRun/
  // startManualRun-adjacent startIllustratedStoryRun entry points; startRun
  // is the one AI-driven run-start method left, and manual runs (which don't
  // touch reasoning agents at all) never gate on this credential.
  const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");

  assert.doesNotMatch(service, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(service, /OLLAMA_BASE_URL/);
  const matches = service.match(/OPENAI_API_KEY.*is not set/g) ?? [];
  assert.equal(matches.length, 1, "startRun should gate on OPENAI_API_KEY");
});
