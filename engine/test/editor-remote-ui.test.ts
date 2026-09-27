/**
 * The editor reaches the full UI through a Cloudflare Tunnel on a public
 * hostname. That is only safe if the server itself insists on a verified
 * Cloudflare Access login: the Host header is client-controlled, so trusting
 * the tunnel alone would hand the UI to anyone who can reach the port.
 *
 * Real RSA keys sign real tokens and a real server answers real requests --
 * the same stance as editor-return-webhook.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
import { createUiServer } from "../src/server.ts";
import { CloudflareAccessVerifier } from "../src/cf-access.ts";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const TEAM = "vidgen-test.cloudflareaccess.com";
const AUD = "aud-tag-123";
const HOST = "editor.example.com";

function keypair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function jwt(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: key.kid, typ: "JWT" });
  const body = enc(claims);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: nowSec() + 600, iat: nowSec(), email: "editor@example.com" });

/** A verifier whose certs endpoint serves whatever keys the test currently publishes. */
function verifierServing(published: { jwk: object }[]) {
  let fetches = 0;
  const fetchImpl = (async (url: string) => {
    fetches++;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: published.map((k) => k.jwk) }), { status: 200 });
  }) as typeof fetch;
  return { verifier: new CloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD, fetchImpl }), fetches: () => fetches };
}

test("a token signed by the team key for this app verifies and yields the editor's email", async () => {
  const k = keypair("k1");
  const { verifier } = verifierServing([k]);
  assert.deepEqual(await verifier.verify(jwt(k, goodClaims())), { email: "editor@example.com" });
});

test("forged, expired, wrong-app and wrong-team tokens are all refused", async () => {
  const k = keypair("k1");
  const attacker = keypair("k1"); // same kid, different key
  const { verifier } = verifierServing([k]);
  const cases: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["garbage", "not.a.jwt"],
    ["signed by another key", jwt(attacker, goodClaims())],
    ["expired", jwt(k, { ...goodClaims(), exp: nowSec() - 5 })],
    ["another Access app", jwt(k, { ...goodClaims(), aud: ["someone-else"] })],
    ["another team", jwt(k, { ...goodClaims(), iss: "https://evil.cloudflareaccess.com" })],
    ["not yet valid", jwt(k, { ...goodClaims(), nbf: nowSec() + 3600 })],
  ];
  for (const [label, token] of cases) {
    assert.equal(await verifier.verify(token), null, label);
  }
});

test("a rotated key is picked up by refetching the certs, not by a restart", async () => {
  const k1 = keypair("k1");
  const k2 = keypair("k2");
  const published = [k1];
  const { verifier, fetches } = verifierServing(published);
  assert.ok(await verifier.verify(jwt(k1, goodClaims())));
  published.push(k2);
  assert.ok(await verifier.verify(jwt(k2, goodClaims())));
  assert.equal(fetches(), 2);
});

// -- the server ------------------------------------------------------------

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

function request(port: number, method: string, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

async function withServer(
  verifier: CloudflareAccessVerifier | null,
  body: (port: number, calls: { measure: number; config: number }) => Promise<void>,
) {
  const calls = { measure: 0, config: 0 };
  const service = {
    listRuns: () => [],
    measureAll: async () => { calls.measure++; return { measured: [], failed: [] }; },
    saveCredentials: async () => { calls.config++; return { applied: [], rejected: [] }; },
    credentials: () => [],
    checkEditorReturns: async () => ({ configured: true, checked: 1, advanced: 1, advanced_runs: ["run_x"], failed_runs: [] }),
    providerSummary: () => ({}),
    capabilities: () => [],
  } as never;
  const port = await freePort();
  const server = createUiServer({ service, uiDir: UI_DIR, port, publicHosts: [HOST], accessVerifier: verifier });
  await server.listen();
  try {
    await body(port, calls);
  } finally {
    await server.close();
  }
}

test("the editor's hostname serves the UI only with a verified Access login", async () => {
  const k = keypair("k1");
  await withServer(verifierServing([k]).verifier, async (port) => {
    const ok = await request(port, "GET", "/api/runs", { host: HOST, "cf-access-jwt-assertion": jwt(k, goodClaims()) });
    assert.equal(ok.status, 200);

    const noLogin = await request(port, "GET", "/api/runs", { host: HOST });
    assert.equal(noLogin.status, 401);

    const forged = await request(port, "GET", "/api/runs", { host: HOST, "cf-access-jwt-assertion": jwt(keypair("k1"), goodClaims()) });
    assert.equal(forged.status, 401);

    // A valid login does not open any hostname other than the configured one.
    const other = await request(port, "GET", "/api/runs", { host: "evil.example.com", "cf-access-jwt-assertion": jwt(k, goodClaims()) });
    assert.equal(other.status, 403);
  });
});

test("remote changes need a same-origin request, and credentials stay server-side", async () => {
  const k = keypair("k1");
  await withServer(verifierServing([k]).verifier, async (port, calls) => {
    const auth = { host: HOST, "cf-access-jwt-assertion": jwt(k, goodClaims()), "content-type": "application/json" };

    const crossSite = await request(port, "POST", "/api/measure", { ...auth, origin: "https://evil.example.com" });
    assert.equal(crossSite.status, 403);
    const noOrigin = await request(port, "POST", "/api/measure", auth);
    assert.equal(noOrigin.status, 403);
    assert.equal(calls.measure, 0);

    const sameOrigin = await request(port, "POST", "/api/measure", { ...auth, origin: `https://${HOST}` });
    assert.equal(sameOrigin.status, 200);
    assert.equal(calls.measure, 1);

    const config = await request(port, "POST", "/api/config", { ...auth, origin: `https://${HOST}` });
    assert.equal(config.status, 403);
    assert.equal(calls.config, 0, "a remote session must never rewrite credentials");
  });
});

test("with Access not configured, the public hostname is refused outright", async () => {
  const k = keypair("k1");
  await withServer(null, async (port) => {
    const res = await request(port, "GET", "/api/runs", { host: HOST, "cf-access-jwt-assertion": jwt(k, goodClaims()) });
    assert.equal(res.status, 403);
  });
});

test("loopback access for the operator is unchanged", async () => {
  await withServer(null, async (port, calls) => {
    assert.equal((await request(port, "GET", "/api/runs", { host: "127.0.0.1" })).status, 200);
    const config = await request(port, "POST", "/api/config", { host: "localhost", "content-type": "application/json" });
    assert.equal(config.status, 200);
    assert.equal(calls.config, 1);
  });
});

test("the editor's 'check for my cut' returns the real outcome, and only to a logged-in editor", async () => {
  const k = keypair("k1");
  await withServer(verifierServing([k]).verifier, async (port) => {
    const auth = { host: HOST, "cf-access-jwt-assertion": jwt(k, goodClaims()), origin: `https://${HOST}`, "content-type": "application/json" };
    const ok = await request(port, "POST", "/api/editor-returns/check-now", auth);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).advanced_runs, ["run_x"]);

    const anon = await request(port, "POST", "/api/editor-returns/check-now", { host: HOST, origin: `https://${HOST}` });
    assert.equal(anon.status, 401);

    const series = await request(port, "GET", "/api/series", { host: HOST, "cf-access-jwt-assertion": jwt(k, goodClaims()) });
    assert.equal(series.status, 200);
    const eps = JSON.parse(series.body).episodes as Array<{ status: string }>;
    assert.equal(eps.length, 8);
    assert.ok(eps.every((e) => e.status === ""), "every episode reports a status field");
  });
});
