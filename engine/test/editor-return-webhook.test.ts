/**
 * The editor-return webhook is the only route on this server reachable from
 * off-box. Everything else is loopback-only because the server holds API keys
 * (GET /api/config reports credential state), so the exception has to be
 * exactly as narrow as it claims: one path, shared-secret required, and
 * invisible when it was never provisioned.
 *
 * These boot a real server and make real requests -- an auth check asserted
 * against a mock proves nothing about the wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
import { createUiServer } from "../src/server.ts";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const TOKEN = "correct-horse-battery-staple";

/** Ask the OS for a free port, then hand it straight back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });
}

async function withServer(
  token: string | undefined,
  body: (port: number, calls: { count: number }) => Promise<void>,
): Promise<void> {
  const previous = process.env["EDITOR_RETURN_WEBHOOK_TOKEN"];
  if (token === undefined) delete process.env["EDITOR_RETURN_WEBHOOK_TOKEN"];
  else process.env["EDITOR_RETURN_WEBHOOK_TOKEN"] = token;

  const calls = { count: 0 };
  const service = {
    checkEditorReturns: async () => {
      calls.count++;
      return { checked: 2, advanced: 1 };
    },
  } as never;

  // createUiServer.listen() echoes the *configured* port, so port 0 would
  // report 0 rather than the one the OS assigned. Reserve a real one first.
  const port = await freePort();
  const server = createUiServer({ service, uiDir: UI_DIR, port });
  await server.listen();
  try {
    await body(port, calls);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env["EDITOR_RETURN_WEBHOOK_TOKEN"];
    else process.env["EDITOR_RETURN_WEBHOOK_TOKEN"] = previous;
  }
}

/**
 * Raw http rather than fetch: `Host` is a forbidden header name for fetch, so
 * a fetch-based test of the loopback guard silently sends the real host and
 * proves nothing.
 */
function request(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const post = (port: number, headers: Record<string, string> = {}) =>
  request(port, "POST", "/api/editor-returns/check", headers);

test("a correctly signed call triggers a check and returns its result", async () => {
  await withServer(TOKEN, async (port, calls) => {
    const res = await post(port, { "x-webhook-token": TOKEN });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { checked: 2, advanced: 1 });
    assert.equal(calls.count, 1);
  });
});

test("a call with no token, a wrong token, or a token prefix is refused", async () => {
  await withServer(TOKEN, async (port, calls) => {
    const cases: Array<Record<string, string>> = [
      {},
      { "x-webhook-token": "wrong" },
      // A length-prefix of the real token must not pass.
      { "x-webhook-token": TOKEN.slice(0, TOKEN.length - 1) },
      { "x-webhook-token": `${TOKEN}x` },
    ];
    for (const headers of cases) {
      const res = await post(port, headers);
      assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(headers)}`);
    }
    assert.equal(calls.count, 0, "an unauthenticated call must never reach the service");
  });
});

test("with no token configured the route does not exist at all", async () => {
  // An unprovisioned deployment must not advertise an unlocked endpoint.
  await withServer(undefined, async (port, calls) => {
    const res = await post(port, { "x-webhook-token": TOKEN });
    assert.equal(res.status, 404);
    assert.equal(calls.count, 0);
  });
});

test("the webhook is the only route reachable with a non-loopback Host header", async () => {
  await withServer(TOKEN, async (port, calls) => {
    const evil = { host: "evil.example.com" };

    const webhook = await post(port, { ...evil, "x-webhook-token": TOKEN });
    assert.equal(webhook.status, 200, "the webhook is deliberately reachable off-box");
    assert.equal(calls.count, 1);

    // The route that reports credential state must stay loopback-only.
    const config = await request(port, "GET", "/api/config", evil);
    assert.equal(config.status, 403);
    assert.match(config.body, /loopback-only/);

    // And the token does not unlock anything else.
    const runs = await request(port, "GET", "/api/runs", { ...evil, "x-webhook-token": TOKEN });
    assert.equal(runs.status, 403);
  });
});
