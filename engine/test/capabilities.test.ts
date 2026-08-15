/**
 * Capability reporting, and the invariant that keeps it honest.
 *
 * The bug these exist to prevent: the image provider was swapped from Fal to
 * stock photography, `service.rebuild()` was updated to read PEXELS_API_KEY,
 * and the UI's credential list was not. The result was a settings panel that
 * offered a dead key and silently refused to save the live one — no error, no
 * log line, just a pipeline that quietly produced placeholder images.
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
    `these keys gate a pipeline stage but are missing from CREDENTIALS, so the ` +
      `UI cannot save them: ${orphans.join(", ")}`,
  );
});

test("the UI does not offer credentials nothing reads", () => {
  // ELEVENLABS_VOICE_ID is a worker option rather than a stage gate, so it is
  // legitimately absent from STAGES; anything else unused is dead weight that
  // will mislead whoever fills the form in.
  const used = new Set([...credentialKeysUsed(), "ELEVENLABS_VOICE_ID"]);
  const dead = CREDENTIALS.map((c) => c.key).filter((k) => !used.has(k));

  assert.deepEqual(dead, [], `offered in the UI but read by nothing: ${dead.join(", ")}`);
});

test("a stage is satisfied by any one complete group, not by a partial one", () => {
  const publish = STAGES.find((s) => s.id === "publish")!;

  // The OAuth trio is all-or-nothing.
  assert.equal(
    credentialsSatisfied(publish, { YOUTUBE_CLIENT_ID: "id", YOUTUBE_CLIENT_SECRET: "s" }),
    false,
    "two thirds of the OAuth trio must not count as satisfied",
  );
  assert.equal(
    credentialsSatisfied(publish, {
      YOUTUBE_CLIENT_ID: "id",
      YOUTUBE_CLIENT_SECRET: "s",
      YOUTUBE_REFRESH_TOKEN: "r",
    }),
    true,
  );
  // The alternative group stands alone.
  assert.equal(credentialsSatisfied(publish, { YOUTUBE_ACCESS_TOKEN: "ya29." }), true);
});

test("blank and whitespace-only values do not count as set", () => {
  const images = STAGES.find((s) => s.id === "images")!;
  assert.equal(credentialsSatisfied(images, { PEXELS_API_KEY: "" }), false);
  assert.equal(credentialsSatisfied(images, { PEXELS_API_KEY: "   " }), false);
  assert.equal(credentialsSatisfied(images, { PEXELS_API_KEY: "k" }), true);
});

test("an optional key cannot enable a stage on its own", () => {
  // Pixabay is only ever consulted after Pexels and Unsplash, so a Pixabay-only
  // deployment has no working image source.
  const images = STAGES.find((s) => s.id === "images")!;
  assert.equal(credentialsSatisfied(images, { PIXABAY_API_KEY: "k" }), false);
});

test("report names the shortest route to fixing an unsatisfied stage", () => {
  const [publish] = capabilityReport({
    allowPublish: true,
    env: { YOUTUBE_CLIENT_ID: "id", YOUTUBE_CLIENT_SECRET: "s" },
  }).filter((s) => s.id === "publish");

  // Two of the trio are present, so completing it needs one key; the access
  // token route needs one too. Either is a one-key fix — but it must not
  // suggest re-entering keys already set.
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
  assert.deepEqual(publish.missing, [], "nothing is missing — the switch is off");
  assert.match(publish.blockedBy ?? "", /AMOS_ALLOW_PUBLISH/);
});

test("a fully configured deployment reports every stage live", () => {
  const report = capabilityReport({
    allowPublish: true,
    env: {
      ANTHROPIC_API_KEY: "sk-ant",
      ELEVENLABS_API_KEY: "el",
      PEXELS_API_KEY: "px",
      COMPOSE_URL: "http://long-compose:4000",
      YOUTUBE_ACCESS_TOKEN: "ya29.",
    },
  });

  assert.deepEqual(
    report.filter((s) => !s.real).map((s) => s.id),
    [],
  );
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
    PEXELS_API_KEY: "px-live",
    NOT_A_REAL_KEY: "whatever",
  });

  assert.deepEqual(applied, ["PEXELS_API_KEY"]);
  assert.deepEqual(rejected, ["NOT_A_REAL_KEY"]);

  const written = await readFile(file, "utf8");
  assert.match(written, /PEXELS_API_KEY=px-live/);
  assert.doesNotMatch(written, /NOT_A_REAL_KEY/, "a refused key must never reach the file");

  delete process.env["PEXELS_API_KEY"];
});

test("the keys the pipeline actually needs are saveable end to end", async () => {
  // The regression itself: these were all silently refused.
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-cred-"));
  const file = path.join(dir, ".env");

  const keys = [
    "PEXELS_API_KEY",
    "UNSPLASH_ACCESS_KEY",
    "PIXABAY_API_KEY",
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
