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

test("OpenAI reasoning requires an API key and has no offline fallback", () => {
  const reasoning = STAGES.find((s) => s.id === "reasoning")!;
  assert.equal(credentialsSatisfied(reasoning, {}), false);
  assert.equal(credentialsSatisfied(reasoning, { OPENAI_API_KEY: "sk-test" }), true);
  assert.match(reasoning.real, /openai/);
  assert.match(reasoning.consequence, /no offline fallback/);
});

test("blank and whitespace-only Fal keys do not enable cartoon artwork", () => {
  const images = STAGES.find((s) => s.id === "images")!;
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "" }), false);
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "   " }), false);
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "fal-live" }), true);
});

test("legacy stock keys cannot accidentally enable the cartoon image stage", () => {
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

test("a fully configured cartoon deployment reports every stage live", () => {
  const report = capabilityReport({
    allowPublish: true,
    env: {
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-5.6-luna",
      ELEVENLABS_API_KEY: "el",
      FAL_KEY: "fal",
      COMPOSE_URL: "http://long-compose:4000",
      CARTOON_CAST_PATH: "/app/config/cast_roster.default.json",
      YOUTUBE_CLIENT_ID: "id",
      YOUTUBE_CLIENT_SECRET: "secret",
      YOUTUBE_REFRESH_TOKEN: "refresh",
    },
  });
  assert.deepEqual(report.filter((s) => !s.real).map((s) => s.id), []);
  assert.equal(report.find((s) => s.id === "reasoning")!.provider, "openai/gpt-5.6-luna");
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

test("the keys the cartoon pipeline actually needs are saveable end to end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-cred-"));
  const file = path.join(dir, ".env");
  const keys = [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "FAL_KEY",
    "CARTOON_CAST_PATH",
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
