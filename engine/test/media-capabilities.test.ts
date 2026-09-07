import { test } from "node:test";
import assert from "node:assert/strict";

import { STAGES, capabilityReport, credentialsSatisfied } from "../src/capabilities.ts";
import { CREDENTIALS } from "../src/config.ts";

const speech = STAGES.find((s) => s.id === "speech")!;
const images = STAGES.find((s) => s.id === "images")!;

test("media controls expose FreeLL speech but no FreeLL image-generation mode", () => {
  const settable = new Set(CREDENTIALS.map((c) => c.key));
  for (const key of [
    "SPEECH_PROVIDER_MODE",
    "FREELLMAPI_SPEECH_MODEL",
    "FREELLMAPI_SPEECH_VOICE",
    "FREELLMAPI_SPEECH_FORMAT",
    "FREELLMAPI_MEDIA_TIMEOUT_MS",
    "FAL_KEY",
    "FAL_MODEL",
    "FAL_EDIT_MODEL",
  ]) {
    assert.equal(settable.has(key), true, `${key} must be saveable through the config UI`);
  }
  for (const removed of ["IMAGE_PROVIDER_MODE", "FREELLMAPI_IMAGE_MODEL", "FREELLMAPI_IMAGE_HERO_MODEL"]) {
    assert.equal(settable.has(removed), false, `${removed} must not remain configurable after RFC 0010`);
  }
});

test("unset media modes retain ElevenLabs speech and Fal image semantics", () => {
  assert.equal(credentialsSatisfied(speech, { ELEVENLABS_API_KEY: "el" }), true);
  assert.equal(credentialsSatisfied(speech, { FREELLMAPI_API_KEY: "free" }), false);
  assert.equal(credentialsSatisfied(images, { FAL_KEY: "fal" }), true);
  assert.equal(credentialsSatisfied(images, { FREELLMAPI_API_KEY: "free" }), false);
});

test("FreeLLM unified key can satisfy speech but never the image stage", () => {
  const env = {
    SPEECH_PROVIDER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free",
  };
  assert.equal(credentialsSatisfied(speech, env), true);
  assert.equal(credentialsSatisfied(images, env), false);
});

test("FreeLL speech does not silently use ElevenLabs when the unified key is missing", () => {
  const env = {
    SPEECH_PROVIDER_MODE: "freellmapi",
    ELEVENLABS_API_KEY: "el",
    FAL_KEY: "fal",
  };
  assert.equal(credentialsSatisfied(speech, env), false);
  assert.equal(credentialsSatisfied(images, env), true);

  const report = capabilityReport({ allowPublish: false, env });
  assert.deepEqual(report.find((s) => s.id === "speech")!.missing, ["FREELLMAPI_API_KEY"]);
  assert.equal(report.find((s) => s.id === "images")!.real, true);
});

test("capability report exposes FreeLL speech and fal image models independently", () => {
  const report = capabilityReport({
    allowPublish: false,
    env: {
      SPEECH_PROVIDER_MODE: "freellmapi",
      FREELLMAPI_API_KEY: "free",
      FREELLMAPI_SPEECH_MODEL: "openai-audio",
      FAL_KEY: "fal",
      FAL_MODEL: "fal-ai/flux-2",
      FAL_EDIT_MODEL: "fal-ai/flux-2/edit",
    },
  });
  assert.equal(report.find((s) => s.id === "speech")!.provider, "freellmapi/openai-audio");
  assert.equal(report.find((s) => s.id === "images")!.provider, "fal/fal-ai/flux-2 + fal-ai/flux-2/edit");
});

test("ElevenLabs speech rollback does not affect fal-only image generation", () => {
  const report = capabilityReport({
    allowPublish: false,
    env: {
      SPEECH_PROVIDER_MODE: "elevenlabs",
      ELEVENLABS_API_KEY: "el",
      FAL_KEY: "fal",
    },
  });
  assert.equal(report.find((s) => s.id === "speech")!.provider, "elevenlabs");
  assert.equal(report.find((s) => s.id === "images")!.provider, "fal/fal-ai/flux-2 + fal-ai/flux-2/edit");
});
