import test from "node:test";
import assert from "node:assert/strict";
import {
  sendOperatorAlert,
  formatOperatorAlertText,
  formatOperatorAlertSubject,
  ALERT_COOLDOWN_MS,
} from "../src/operator-alerts.ts";

const payload = {
  run_id: "run_b77fcfdc-6723-465f-be82-5c11d7ce1a65",
  reason: "still blocked by pre-TTS moderation review after 3 script rewrites",
  failures: [{ node_id: "voice", error: "voice blocked by pre-TTS moderation (review): scene 2: ..." }],
};

test("formatOperatorAlertText reads as a report, not a log line", () => {
  const text = formatOperatorAlertText(payload);
  assert.match(text, /^Run b77fcfdc stopped and needs a human\./);
  assert.match(text, /WHY\n {2}still blocked by pre-TTS moderation review after 3 script rewrites/);
  assert.match(text, /WHERE IT STOPPED\n {2}- voice: voice blocked by pre-TTS moderation \(review\)/);
  // The full id is what an operator needs to act on the run.
  assert.match(text, /RUN ID\n {2}run_b77fcfdc-6723-465f-be82-5c11d7ce1a65/);
});

test("a multi-line provider error is collapsed instead of filling the email with JSON", () => {
  const text = formatOperatorAlertText({
    ...payload,
    failures: [{ node_id: "draft_script", error: 'openai/gpt-6-astra request failed (429): {\n  "error": {\n    "message": "Too Many Requests"\n  }\n}' }],
  });
  const step = text.split("\n").find((line) => line.includes("draft_script"))!;
  assert.equal(step, '  - draft_script: openai/gpt-6-astra request failed (429): { "error": { "message": "Too Many Requests" } }');
});

test("the subject carries the run id and failing step so Gmail cannot thread unrelated alerts", () => {
  assert.equal(formatOperatorAlertSubject(payload), "VidGen: run b77fcfdc stuck at voice");
  assert.equal(
    formatOperatorAlertSubject({ ...payload, failures: [] }),
    "VidGen: run b77fcfdc needs attention",
  );
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

  // Each test uses its own run id: the cooldown map is module-level state,
  // so sharing one would let an earlier test silently suppress a later one.
  const own = { ...payload, run_id: "run_webhook1" };
  await sendOperatorAlert(own, { webhookUrl: "https://example.test/webhook", fetchImpl });

  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, "https://example.test/webhook");
  assert.equal((posted[0]!.body as { run_id: string }).run_id, own.run_id);
});

test("sendOperatorAlert emails via Resend only when api key, to and from are all set", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const own = { ...payload, run_id: "run_b77fcfdc-resend" };
  // Missing `from` -> no email attempt.
  await sendOperatorAlert(own, { resendApiKey: "key", emailTo: "ops@example.test", fetchImpl });
  assert.equal(requests.length, 0);

  await sendOperatorAlert(own, {
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

test("the same run+failure alerts once, not on every scheduler retry", async () => {
  // Production incident 2026-09-19: run 69dbad4e sat blocked on a provider
  // 429 while the scheduler re-entered driveUnattended() every ~16 minutes,
  // sending 41 identical emails in a day.
  const posted: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const repeat = { ...payload, run_id: "run_dedup01-aaaa" };
  const send = (now: number) =>
    sendOperatorAlert(repeat, { webhookUrl: "https://example.test/webhook", fetchImpl, now });

  await send(0);
  // The error text carries a fresh provider request id every retry, so dedup
  // must key on the run + failing node, not on the message.
  await sendOperatorAlert(
    { ...repeat, failures: [{ node_id: "voice", error: "openai/gpt-6-astra request failed (429): req_a1b2c3" }] },
    { webhookUrl: "https://example.test/webhook", fetchImpl, now: 60_000 },
  );
  await send(60 * 60_000);
  assert.equal(posted.length, 1, "repeat give-ups for the same run must stay silent inside the cooldown");

  await send(ALERT_COOLDOWN_MS + 1);
  assert.equal(posted.length, 2, "a still-broken run re-alerts once the cooldown expires");
});

test("a different run or a different failure is never suppressed", async () => {
  const posted: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const opts = { webhookUrl: "https://example.test/webhook", fetchImpl, now: 0 };

  await sendOperatorAlert({ ...payload, run_id: "run_distinct1" }, opts);
  await sendOperatorAlert({ ...payload, run_id: "run_distinct2" }, opts);
  await sendOperatorAlert(
    { ...payload, run_id: "run_distinct1", reason: "structural package-contract defect cannot be auto-repaired" },
    opts,
  );
  assert.equal(posted.length, 3);
});

test("an unconfigured alert does not consume the cooldown", async () => {
  const posted: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const unconfigured = { ...payload, run_id: "run_nodest01" };

  await sendOperatorAlert(unconfigured, { fetchImpl, now: 0 });
  await sendOperatorAlert(unconfigured, { webhookUrl: "https://example.test/webhook", fetchImpl, now: 1000 });
  assert.equal(posted.length, 1, "the first deliverable alert must still go out");
});

test("sendOperatorAlert never throws when the webhook call fails", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; throw new Error("network down"); }) as unknown as typeof fetch;
  await assert.doesNotReject(
    sendOperatorAlert({ ...payload, run_id: "run_throws01" }, { webhookUrl: "https://example.test/webhook", fetchImpl }),
  );
  assert.equal(called, true, "the failure path must actually be exercised, not skipped by the cooldown");
});
