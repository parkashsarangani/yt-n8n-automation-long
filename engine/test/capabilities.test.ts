/**
 * Capability reporting, and the invariant that keeps it honest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  STAGES,
  capabilityReport,
  credentialKeysUsed,
  credentialsSatisfied,
} from "../src/capabilities.ts";
import { CREDENTIALS, writeEnvFile } from "../src/config.ts";

test("every credential a stage depends on can be set in the UI", () => {
  const settable = new Set(CREDENTIALS.map((c) => c.key));
  const orphans = credentialKeysUsed().filter((k) => !settable.has(k));
  assert.deepEqual(
    orphans,
    [],
    `these keys gate a pipeline stage but are missing from CREDENTIALS, so the UI cannot save them: ${orphans.join(", ")}`,
  );
});

test("the UI does not offer unexplained credentials", () => {
  const TUNING_NOT_GATING = [
    "ELEVENLABS_VOICE_ID",
    "MEASURE_EXCLUDE_IDS",
    "SCHEDULE_MEASURE_HOURS",
    "SCHEDULE_PRODUCE_HOURS",
    "PEXELS_API_KEY",
    "UNSPLASH_ACCESS_KEY",
    "PIXABAY_API_KEY",
  ];
  const used = new Set([...credentialKeysUsed(), ...TUNING_NOT_GATING]);
  const dead = CREDENTIALS.map((c) => c.key).filter((k) => !used.has(k));
  assert.deepEqual(dead, [], `offered in the UI but read by nothing: ${dead.join(", ")}`);
});

test("a stage is satisfied by any one complete group, not by a partial one", () => {
  const publish = STAGES.find((s) => s.id === "publish")!;
  assert.equal(
    credentialsSatisfied(publish, { YOUTUBE_CLIENT_ID: "id", YOUTUBE_CLIENT_SECRET: "s" }),
    false,
  );
  assert.equal(
    credentialsSatisfied(publish, {
      YOUTUBE_CLIENT_ID: "id",
      YOUTUBE_CLIENT_SECRET: "s",
      YOUTUBE_REFRESH_TOKEN: "r",
    }),
    true,
  );
  assert.equal(credentialsSatisfied(publish, { YOUTUBE_ACCESS_TOKEN: "ya29." }), true);
});

test("reasoning is free-only: the free key satisfies it, a paid-only key does not", () => {
  const reasoning = STAGES.find((s) => s.id === "reasoning")!;
  assert.equal(credentialsSatisfied(reasoning, {}), false);
  assert.equal(credentialsSatisfied(reasoning, { FREELLMAPI_API_KEY: "free" }), true);
  assert.equal(credentialsSatisfied(reasoning, { OPENAI_API_KEY: "paid" }), false, "there is no paid text fallback; a paid-only key cannot run reasoning");
  assert.equal(credentialsSatisfied(reasoning, {
    FREELLMAPI_API_KEY: "free",
    LLM_ROUTER_MODE: "direct",
  }), false, "direct rollback mode requires the direct provider credential");
  assert.equal(credentialsSatisfied(reasoning, {
    OPENAI_API_KEY: "paid",
    LLM_ROUTER_MODE: "direct",
  }), true);
  assert.match(reasoning.consequence, /no paid fallback/);
});

test("reasoning capability report shows the ordered free-model chain, no paid fallback", () => {
  const reasoning = capabilityReport({
    allowPublish: false,
    env: {
      FREELLMAPI_API_KEY: "free",
      FREELLMAPI_TEXT_MODELS: "model-a,model-b,model-c,model-d",
      OPENAI_API_KEY: "paid",
      OPENAI_MODEL: "gpt-5.6-luna",
    },
  }).find((s) => s.id === "reasoning")!;
  assert.equal(reasoning.real, true);
  assert.equal(reasoning.provider, "freellmapi free chain [model-a, model-b, model-c, +1]");
  assert.doesNotMatch(reasoning.provider, /openai|fail-open/);
  assert.deepEqual(reasoning.missing, []);
});

test("reasoning is unavailable when the free key is missing, even with a paid key present", () => {
  const reasoning = capabilityReport({
    allowPublish: false,
    env: { OPENAI_API_KEY: "paid", OPENAI_MODEL: "gpt-5.6-luna" },
  }).find((s) => s.id === "reasoning")!;
  assert.equal(reasoning.real, false);
  assert.deepEqual(reasoning.missing, ["FREELLMAPI_API_KEY"]);
});

test("direct rollback is reported as direct OpenAI rather than FreeLLMAPI", () => {
  const reasoning = capabilityReport({
    allowPublish: false,
    env: {
      LLM_ROUTER_MODE: "direct",
      FREELLMAPI_API_KEY: "free",
      OPENAI_API_KEY: "paid",
      OPENAI_MODEL: "gpt-5.6-terra",
    },
  }).find((s) => s.id === "reasoning")!;
  assert.equal(reasoning.real, true);
  assert.equal(reasoning.provider, "openai/gpt-5.6-terra (manual rollback)");
});

test("visual QA defaults to the free text proxy; real pixel vision is opt-in", () => {
  const visual = STAGES.find((s) => s.id === "visual_qa")!;
  // Default (proxy) mode: the free key satisfies it, a paid-only key does not.
  assert.equal(credentialsSatisfied(visual, { FREELLMAPI_API_KEY: "free" }), true);
  assert.equal(credentialsSatisfied(visual, { OPENAI_API_KEY: "paid" }), false);
  // Opt-in real mode: now it needs the OpenAI key.
  assert.equal(credentialsSatisfied(visual, { VISUAL_QA_MODE: "real", OPENAI_API_KEY: "paid" }), true);
  assert.equal(credentialsSatisfied(visual, { VISUAL_QA_MODE: "real", FREELLMAPI_API_KEY: "free" }), false);

  const proxy = capabilityReport({
    allowPublish: false,
    env: { FREELLMAPI_API_KEY: "free" },
  }).find((s) => s.id === "visual_qa")!;
  assert.equal(proxy.real, true);
  assert.equal(proxy.provider, "free text semantic proxy (no paid vision)");

  const realVision = capabilityReport({
    allowPublish: false,
    env: { VISUAL_QA_MODE: "real", OPENAI_API_KEY: "paid", OPENAI_IMAGE_QA_MODEL: "vision-model" },
  }).find((s) => s.id === "visual_qa")!;
  assert.equal(realVision.real, true);
  assert.equal(realVision.provider, "openai/vision-model (real vision, opt-in)");
});

test("blank and whitespace-only Fal keys do not enable illustration artwork", () => {
  const images = STAGES.find((s) => s.id === "images")!;
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "" }), false);
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "   " }), false);
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "fal-live" }), true);
});

test("legacy stock keys cannot accidentally enable the illustration image stage", () => {
  const images = STAGES.find((s) => s.id === "images")!;
  assert.equal(credentialsSatisfied(images, { PEXELS_API_KEY: "px" }), false);
  assert.equal(credentialsSatisfied(images, { UNSPLASH_ACCESS_KEY: "un" }), false);
  assert.equal(credentialsSatisfied(images, { PIXABAY_API_KEY: "pb" }), false);
});

test("report names the shortest route to fixing an unsatisfied stage", () => {
  const [publish] = capabilityReport({
    allowPublish: true,
    env: { YOUTUBE_CLIENT_ID: "id", YOUTUBE_CLIENT_SECRET: "s" },
  }).filter((s) => s.id === "publish");
  assert.ok(publish);
  assert.equal(publish.real, false);
  assert.deepEqual(publish.missing, ["YOUTUBE_REFRESH_TOKEN"]);
});

test("credentials present but publishing switched off is reported as blocked, not missing", () => {
  const publish = capabilityReport({
    allowPublish: false,
    env: { YOUTUBE_ACCESS_TOKEN: "ya29." },
  }).find((s) => s.id === "publish")!;
  assert.equal(publish.real, false);
  assert.deepEqual(publish.missing, []);
  assert.match(publish.blockedBy ?? "", /AMOS_ALLOW_PUBLISH/);
});

test("a fully configured deployment reports every stage live", () => {
  const report = capabilityReport({
    allowPublish: true,
    env: {
      FREELLMAPI_API_KEY: "free-test",
      FREELLMAPI_TEXT_MODELS: "model-a,model-b,model-c",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-5.6-luna",
      ELEVENLABS_API_KEY: "el",
      FAL_KEY: "fal",
      COMPOSE_URL: "http://long-compose:4000",
      YOUTUBE_CLIENT_ID: "id",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh",
    },
  });
  assert.deepEqual(report.filter((s) => !s.real).map((s) => s.id), []);
  assert.equal(report.find((s) => s.id === "reasoning")!.provider, "freellmapi free chain [model-a, model-b, model-c]");
  assert.equal(report.find((s) => s.id === "visual_qa")!.provider, "free text semantic proxy (no paid vision)");
});

test("the stopgap access token can publish but cannot measure", () => {
  const report = capabilityReport({
    allowPublish: true,
    env: { YOUTUBE_ACCESS_TOKEN: "ya29." },
  });
  assert.equal(report.find((s) => s.id === "publish")!.real, true);
  const analytics = report.find((s) => s.id === "analytics")!;
  assert.equal(analytics.real, false);
  assert.deepEqual(analytics.missing, [
    "YOUTUBE_CLIENT_ID",
    "YOUTUBE_CLIENT_SECRET",
    "YOUTUBE_REFRESH_TOKEN",
  ]);
});

test("measurement is not gated behind the publish switch", () => {
  const report = capabilityReport({
    allowPublish: false,
    env: {
      YOUTUBE_CLIENT_ID: "id",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh",
    },
  });
  assert.equal(report.find((s) => s.id === "analytics")!.real, true);
  assert.equal(report.find((s) => s.id === "publish")!.real, false);
});

test("an empty deployment reports every stage down with a fix for each", () => {
  const report = capabilityReport({ allowPublish: false, env: {} });
  assert.equal(report.every((s) => !s.real), true);
  for (const s of report) {
    assert.ok(s.missing.length > 0, `${s.id} should name the keys it needs`);
    assert.ok(s.consequence.length > 0, `${s.id} should say what happens without it`);
  }
});

test("saving an unknown key is reported, not silently dropped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-cred-"));
  const file = path.join(dir, ".env");
  const { applied, rejected } = await writeEnvFile(file, {
    FAL_KEY: "fal-live",
    NOT_A_REAL_KEY: "whatever",
  });
  assert.deepEqual(applied, ["FAL_KEY"]);
  assert.deepEqual(rejected, ["NOT_A_REAL_KEY"]);
  const written = await readFile(file, "utf8");
  assert.match(written, /FAL_KEY=fal-live/);
  assert.doesNotMatch(written, /NOT_A_REAL_KEY/);
  delete process.env["FAL_KEY"];
});

test("the keys the illustrated-story and RFC0010 paths need are saveable end to end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-cred-"));
  const file = path.join(dir, ".env");
  const keys = [
    "FREELLMAPI_API_KEY",
    "LLM_ROUTER_MODE",
    "LLM_ROUTER_TIMEOUT_MS",
    "FREELLMAPI_BASE_URL",
    "FREELLMAPI_TEXT_MODELS",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_IMAGE_QA_MODEL",
    "FAL_KEY",
    "YOUTUBE_CLIENT_ID",
    "YOUTUBE_CLIENT_SECRET",
    "YOUTUBE_REFRESH_TOKEN",
  ];
  const updates = Object.fromEntries(keys.map((k) => [k, `value-for-${k}`]));
  const { applied, rejected } = await writeEnvFile(file, updates);
  assert.deepEqual(rejected, []);
  assert.deepEqual(applied.sort(), [...keys].sort());
  for (const k of keys) delete process.env[k];
});
