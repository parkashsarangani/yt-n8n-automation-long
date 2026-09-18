import test from "node:test";
import assert from "node:assert/strict";
import { sendOperatorAlert, formatOperatorAlertText } from "../src/operator-alerts.ts";

const payload = {
  run_id: "run_b77fcfdc-6723-465f-be82-5c11d7ce1a65",
  reason: "still blocked by pre-TTS moderation review after 3 script rewrites",
  failures: [{ node_id: "voice", error: "voice blocked by pre-TTS moderation (review): scene 2: ..." }],
};

test("formatOperatorAlertText includes the shortened run id, reason and failure detail", () => {
  const text = formatOperatorAlertText(payload);
  assert.match(text, /run b77fcfdc/);
  assert.match(text, /still blocked by pre-TTS moderation review after 3 script rewrites/);
  assert.match(text, /voice: voice blocked by pre-TTS moderation \(review\)/);
});

test("sendOperatorAlert is a no-op with nothing configured", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response(null, { status: 200 }); }) as typeof fetch;
  await sendOperatorAlert(payload, { fetchImpl });
  assert.equal(called, false);
});

test("sendOperatorAlert posts to the webhook when configured", async () => {
  const posted: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  await sendOperatorAlert(payload, { webhookUrl: "https://example.test/webhook", fetchImpl });

  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, "https://example.test/webhook");
  assert.equal((posted[0]!.body as { run_id: string }).run_id, payload.run_id);
});

test("sendOperatorAlert emails via Resend only when api key, to and from are all set", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  // Missing `from` -> no email attempt.
  await sendOperatorAlert(payload, { resendApiKey: "key", emailTo: "ops@example.test", fetchImpl });
  assert.equal(requests.length, 0);

  await sendOperatorAlert(payload, {
    resendApiKey: "key",
    emailTo: "ops@example.test",
    emailFrom: "alerts@example.test",
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.resend.com/emails");
  assert.equal((requests[0]!.init.headers as Record<string, string>)["authorization"], "Bearer key");
  const body = JSON.parse(String(requests[0]!.init.body));
  assert.deepEqual(body.to, ["ops@example.test"]);
  assert.equal(body.from, "alerts@example.test");
  assert.match(body.subject, /run b77fcfdc/);
});

test("sendOperatorAlert never throws when the webhook call fails", async () => {
  const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  await assert.doesNotReject(sendOperatorAlert(payload, { webhookUrl: "https://example.test/webhook", fetchImpl }));
});
