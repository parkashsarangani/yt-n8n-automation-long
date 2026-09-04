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

test("reasoning is FreeLLMAPI-first with explicit direct rollback and optional paid fail-open", () => {
  const reasoning = STAGES.find((s) => s.id === "reasoning")!;
  assert.equal(credentialsSatisfied(reasoning, {}), false);
  assert.equal(credentialsSatisfied(reasoning, { FREELLMAPI_API_KEY: "free" }), true);
  assert.equal(credentialsSatisfied(reasoning, { OPENAI_API_KEY: "paid" }), true, "default fail-open keeps existing deployments live while FreeLLMAPI is configured");
  assert.equal(credentialsSatisfied(reasoning, {
    OPENAI_API_KEY: "paid",
    LLM_ROUTER_FAIL_OPEN_TO_DIRECT: "false",
  }), false, "strict free mode must not pretend a paid-only credential is usable");
  assert.equal(credentialsSatisfied(reasoning, {
    FREELLMAPI_API_KEY: "free",
    LLM_ROUTER_MODE: "direct",
  }), false, "direct rollback mode requires the direct provider credential");
  assert.equal(credentialsSatisfied(reasoning, {
    OPENAI_API_KEY: "paid",
    LLM_ROUTER_MODE: "direct",
  }), true);
  assert.match(reasoning.consequence, /no offline model fallback/);
});

test("reasoning capability report exposes free primary and paid fail-open without hiding either route", () => {
  const reasoning = capabilityReport({
    allowPublish: false,
    env: {
      FREELLMAPI_API_KEY: "free",
      FREELLMAPI_TEXT_MODEL: "auto:smart",
      OPENAI_API_KEY: "paid",
      OPENAI_MODEL: "gpt-5.6-luna",
    },
  }).find((s) => s.id === "reasoning")!;
  assert.equal(reasoning.real, true);
  assert.equal(reasoning.provider, "freellmapi/auto:smart → openai/gpt-5.6-luna fail-open");
  assert.deepEqual(reasoning.missing, []);
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
  assert.equal(reasoning.provider, "openai/gpt-5.6-terra");
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

test("strict free mode reports the FreeLLMAPI key as the missing reasoning credential", () => {
  const reasoning = capabilityReport({
    allowPublish: false,
    env: {
      OPENAI_API_KEY: "paid",
      LLM_ROUTER_FAIL_OPEN_TO_DIRECT: "false",
    },
  }).find((s) => s.id === "reasoning")!;
  assert.equal(reasoning.real, false);
  assert.deepEqual(reasoning.missing, ["FREELLMAPI_API_KEY"]);
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
      FREELLMAPI_TEXT_MODEL: "auto:smart",
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
  assert.equal(report.find((s) => s.id === "reasoning")!.provider, "freellmapi/auto:smart → openai/gpt-5.6-luna fail-open");
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

test("the keys the illustrated-story pipeline actually needs are saveable end to end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-cred-"));
  const file = path.join(dir, ".env");
  const keys = [
    "FREELLMAPI_API_KEY",
    "LLM_ROUTER_MODE",
    "LLM_ROUTER_FAIL_OPEN_TO_DIRECT",
    "LLM_ROUTER_TIMEOUT_MS",
    "FREELLMAPI_BASE_URL",
    "FREELLMAPI_TEXT_MODEL",
    "FREELLMAPI_VISION_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
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
