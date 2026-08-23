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

test("low-risk agents request low-effort fast reasoning", () => {
  const lowRisk = [
    "discovery.json",
    "seo_optimizer.json",
    "thumbnail_designer.json",
    "cartoon_thumbnail_designer.json",
    "channel_strategist.json",
  ];

  for (const file of lowRisk) {
    const def = agent(file);
    assert.equal(def.model.capability, "reasoning_fast", `${def.name} should use the fast capability`);
    assert.equal(def.model.effort, "low", `${def.name} should be eligible for Haiku downgrade`);
  }
});

test("core creative cartoon agents do not request low-effort model downgrades", () => {
  const protectedAgents = [
    "story_architect.json",
    "script_writer.json",
    "dialogue_script_writer.json",
    "visual_planner.json",
    "cartoon_visual_planner.json",
    "cartoon_creative_director.json",
  ];

  for (const file of protectedAgents) {
    const def = agent(file);
    assert.notEqual(def.model.effort, "low", `${def.name} should stay on Sonnet-class routing`);
  }
});

test("agent output budgets stay bounded", () => {
  const ceilings: Record<string, number> = {
    "discovery.json": 3000,
    "seo_optimizer.json": 2000,
    "thumbnail_designer.json": 2000,
    "cartoon_thumbnail_designer.json": 4096,
    "channel_strategist.json": 3000,
    "story_architect.json": 5000,
    "script_writer.json": 10000,
    "dialogue_script_writer.json": 16000,
    "visual_planner.json": 10000,
    "cartoon_visual_planner.json": 16000,
    "cartoon_creative_director.json": 12000,
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
