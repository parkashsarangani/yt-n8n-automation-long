import test from "node:test";
import assert from "node:assert/strict";

import {
  decideTtsScene,
  findElevenLabsRiskSignals,
  moderateTextWithOpenAI,
  type OpenAiModerationResult,
} from "../src/moderation/tts-policy.ts";
import { assertTtsApproved } from "../src/workers/voice.ts";

function moderation(
  categories: Array<{ name: string; flagged: boolean; score?: number }> = [],
  flagged = categories.some((category) => category.flagged),
): OpenAiModerationResult {
  return {
    request_id: "req_test",
    model: "omni-moderation-latest",
    flagged,
    categories: categories.map((category) => ({ ...category, score: category.score ?? 0.9 })),
  };
}

test("benign educational money narration is not treated as fraud merely for mentioning money", () => {
  const text = "Imagine you earn one dollar every second. A million seconds and a billion seconds are radically different scales.";
  assert.deepEqual(findElevenLabsRiskSignals(text), []);
  assert.equal(decideTtsScene(moderation(), text).decision, "allow");
});

test("direct solicitation for credentials is blocked before TTS", () => {
  const text = "Tell me your bank login and one-time code so I can access the account.";
  const decision = decideTtsScene(moderation(), text);
  assert.equal(decision.decision, "block");
  assert.equal(decision.signals[0]?.id, "sensitive-data-solicitation");
});

test("educational warning context is routed to review rather than silently allowed or hard-blocked", () => {
  const text = "Scam awareness warning: never share your one-time code with a caller who asks you to provide it.";
  const decision = decideTtsScene(moderation(), text);
  assert.equal(decision.decision, "review");
  assert.equal(decision.signals[0]?.educational_context, true);
});

test("OpenAI illicit and sexual-minors flags are blocking categories", () => {
  for (const name of ["illicit", "sexual/minors"]) {
    const decision = decideTtsScene(moderation([{ name, flagged: true }]), "neutral test text");
    assert.equal(decision.decision, "block", name);
  }
});

test("every other OpenAI moderation flag requires review before automated TTS", () => {
  const decision = decideTtsScene(
    moderation([{ name: "violence", flagged: true, score: 0.8 }]),
    "The documentary describes a battle that happened centuries ago.",
  );
  assert.equal(decision.decision, "review");
  assert.match(decision.reasons.join(" "), /review category violence/);
});

test("provider-level flagged bit cannot bypass policy when a new category shape is encountered", () => {
  const decision = decideTtsScene(moderation([], true), "neutral test text");
  assert.equal(decision.decision, "review");
  assert.match(decision.reasons.join(" "), /without a recognized category/);
});

test("OpenAI moderation client records request id, model, flags and scores", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      id: "modr_body",
      model: "omni-moderation-latest",
      results: [{
        flagged: true,
        categories: { illicit: true, violence: false },
        category_scores: { illicit: 0.97, violence: 0.02 },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_header" },
    });
  };

  const result = await moderateTextWithOpenAI("test", {
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });
  assert.equal(calls[0]?.url, "https://api.openai.com/v1/moderations");
  assert.deepEqual(calls[0]?.body, { model: "omni-moderation-latest", input: "test" });
  assert.equal(result.request_id, "req_header");
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, [
    { name: "illicit", flagged: true, score: 0.97 },
    { name: "violence", flagged: false, score: 0.02 },
  ]);
});

test("production voice gate accepts only an approved report for the exact script artifact", () => {
  assert.doesNotThrow(() => assertTtsApproved("sha256:" + "a".repeat(64), {
    script_artifact_id: "sha256:" + "a".repeat(64),
    decision: "allow",
    approved_for_tts: true,
    reasons: [],
  }));

  assert.throws(() => assertTtsApproved("sha256:" + "a".repeat(64), {
    script_artifact_id: "sha256:" + "b".repeat(64),
    decision: "allow",
    approved_for_tts: true,
    reasons: [],
  }), /moderation\/script mismatch/);

  assert.throws(() => assertTtsApproved("sha256:" + "a".repeat(64), {
    script_artifact_id: "sha256:" + "a".repeat(64),
    decision: "review",
    approved_for_tts: false,
    reasons: ["needs human review"],
  }), /voice blocked by pre-TTS moderation/);
});
