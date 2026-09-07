import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ensureVisionCapability, resetVisionCapability, type VisionCanaryFetch } from "../src/vision-capability.ts";

beforeEach(() => resetVisionCapability());

const ENDPOINT = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "vision-model",
  label: "test-vision",
};

function response(content: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  };
}

test("vision capability canary requires the known number to be read from the attached pixels", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: VisionCanaryFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return response({ number: "7391", saw_image: true });
  };

  assert.equal(await ensureVisionCapability(ENDPOINT, fetchImpl), true);
  assert.equal(await ensureVisionCapability(ENDPOINT, fetchImpl), true, "result is cached per endpoint/model");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  const messages = calls[0]!.body["messages"] as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(messages[0]!.content.some((part) => part["type"] === "image_url"), true);
});

test("a fabricated text-only 200 fails the canary and stays failed for the run", async () => {
  let calls = 0;
  const fetchImpl: VisionCanaryFetch = async () => {
    calls += 1;
    return response({ number: "", saw_image: false });
  };

  assert.equal(await ensureVisionCapability(ENDPOINT, fetchImpl), false);
  assert.equal(await ensureVisionCapability(ENDPOINT, fetchImpl), false);
  assert.equal(calls, 1, "failed capability is sticky until reset/new process");
});

test("HTTP failure is not mistaken for an unavailable-quality score", async () => {
  const fetchImpl: VisionCanaryFetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
  });
  assert.equal(await ensureVisionCapability(ENDPOINT, fetchImpl), false);
});
