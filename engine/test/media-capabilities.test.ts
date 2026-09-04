import { test } from "node:test";
import assert from "node:assert/strict";

import { STAGES, capabilityReport, credentialsSatisfied } from "../src/capabilities.ts";
import { CREDENTIALS } from "../src/config.ts";

const speech = STAGES.find((s) => s.id === "speech")!;
const images = STAGES.find((s) => s.id === "images")!;

test("all experimental media controls are exposed through Long config", () => {
  const settable = new Set(CREDENTIALS.map((c) => c.key));
  for (const key of [
    "IMAGE_PROVIDER_MODE",
    "SPEECH_PROVIDER_MODE",
    "FREELLMAPI_IMAGE_MODEL",
    "FREELLMAPI_SPEECH_MODEL",
    "FREELLMAPI_SPEECH_VOICE",
    "FREELLMAPI_SPEECH_FORMAT",
    "FREELLMAPI_MEDIA_TIMEOUT_MS",
  ]) {
    assert.equal(settable.has(key), true, `${key} must be saveable through the config UI`);
  }
});

test("unset media modes retain ElevenLabs and Fal credential semantics", () => {
  assert.equal(credentialsSatisfied(speech, { ELEVENLABS_API_KEY: "el" }), true);
  assert.equal(credentialsSatisfied(speech, { FREELLMAPI_API_KEY: "free" }), false);
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "fal" }), true);
  assert.equal(credentialsSatisfied(images, { FREELLMAPI_API_KEY: "free" }), false);
});

test("FreeLLM media modes are satisfied by the shared unified key", () => {
  const env = {
    SPEECH_PROVIDER_MODE: "freellmapi",
    IMAGE_PROVIDER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free",
  };
  assert.equal(credentialsSatisfied(speech, env), true);
  assert.equal(credentialsSatisfied(images, env), true);
});

test("FreeLLM media modes do not silently use paid media credentials when the shared key is missing", () => {
  const env = {
    SPEECH_PROVIDER_MODE: "freellmapi",
    IMAGE_PROVIDER_MODE: "freellmapi",
    ELEVENLABS_API_KEY: "el",
    FAL_KEY: "fal",
  };
  assert.equal(credentialsSatisfied(speech, env), false);
  assert.equal(credentialsSatisfied(images, env), false);

  const report = capabilityReport({ allowPublish: false, env });
  assert.deepEqual(report.find((s) => s.id === "speech")!.missing, ["FREELLMAPI_API_KEY"]);
  assert.deepEqual(report.find((s) => s.id === "images")!.missing, ["FREELLMAPI_API_KEY"]);
});

test("capability report makes the experimental limitations and selected models visible", () => {
  const report = capabilityReport({
    allowPublish: false,
    env: {
      SPEECH_PROVIDER_MODE: "freellmapi",
      IMAGE_PROVIDER_MODE: "freellmapi",
      FREELLMAPI_API_KEY: "free",
      FREELLMAPI_SPEECH_MODEL: "openai-audio",
      FREELLMAPI_IMAGE_MODEL: "flux",
    },
  });
  assert.equal(report.find((s) => s.id === "speech")!.provider, "freellmapi/openai-audio");
  assert.equal(
    report.find((s) => s.id === "images")!.provider,
    "freellmapi/flux (text-to-image; no reference edit)",
  );
});

test("rollback modes report the established paid providers", () => {
  const report = capabilityReport({
    allowPublish: false,
    env: {
      SPEECH_PROVIDER_MODE: "elevenlabs",
      IMAGE_PROVIDER_MODE: "fal",
      ELEVENLABS_API_KEY: "el",
      FAL_KEY: "fal",
    },
  });
  assert.equal(report.find((s) => s.id === "speech")!.provider, "elevenlabs");
  assert.equal(report.find((s) => s.id === "images")!.provider, "fal/flux-2 + flux-2/edit");
});
