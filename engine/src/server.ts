/**
 * Local control UI (HTTP).
 *
 * Deliberately loopback-only and unauthenticated: it is a single-operator tool
 * that holds API keys, so it must not be exposed to a network. Requests whose
 * Host header is not localhost are refused rather than served.
 *
 * Secrets are never sent to the browser — the credentials endpoint returns
 * masked previews only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VidGenService } from "./service.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface ServerOptions {
  service: VidGenService;
  uiDir: string;
  port?: number;
  host?: string;
}

export function createUiServer(opts: ServerOptions) {
  const { service, uiDir } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4321;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqStart = Date.now();
    // Loopback guard: refuse anything that did not arrive at localhost. This is
    // the only thing standing between a stray bind and a key-holding UI on a LAN.
    const hostHeader = (req.headers.host ?? "").split(":")[0];
    const allowedHosts = ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"];
    if (!allowedHosts.includes(hostHeader ?? "")) {
      json(res, 403, { error: "this UI is loopback-only" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    // --- static ---
    if (route === "GET /") {
      const html = await readFile(path.join(uiDir, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // --- config ---
    if (route === "GET /api/config") {
      json(res, 200, {
        credentials: service.credentials(),
        providers: service.providerSummary(),
        env_file: service.envFile,
        graph: `${service.graphDoc.graph_id}@${service.graphDoc.version}`,
      });
      return;
    }

    if (route === "POST /api/config") {
      const body = (await readJson(req)) as { updates?: Record<string, unknown> };
      const updates: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.updates ?? {})) {
        if (typeof v === "string") updates[k] = v;
      }
      const applied = await service.saveCredentials(updates);
      // Echo only which keys changed — never their values.
      json(res, 200, { applied, credentials: service.credentials(), providers: service.providerSummary() });
      return;
    }

    // --- runs ---
    if (route === "GET /api/runs") {
      const runs = service.listRuns();
      // Don't compute cost for every run on every poll — too many DB queries.
      // Cost is computed on the detail view only.
      json(res, 200, { runs });
      return;
    }

    if (route === "POST /api/runs") {
      const body = (await readJson(req)) as { brief?: string; duration_sec?: number };
      const runId = await service.startRun(String(body.brief ?? ""), body.duration_sec ?? 540);
      json(res, 201, { run_id: runId });
      return;
    }

    const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const run = service.getRun(runMatch[1]!);
      if (!run) return json(res, 404, { error: "unknown run" });
      run.cost_usd = await service.costOf(run.run_id);
      json(res, 200, { run, records: await service.runRecords(run.run_id) });
      return;
    }

    const decideMatch = /^\/api\/runs\/([A-Za-z0-9_-]+)\/decide$/.exec(url.pathname);
    if (req.method === "POST" && decideMatch) {
      const body = (await readJson(req)) as {
        node_id?: string;
        approve?: boolean;
        reason?: string;
      };
      if (!body.node_id) return json(res, 400, { error: "node_id is required" });
      await service.decide(
        decideMatch[1]!,
        body.node_id,
        body.approve
          ? { result: "approve" }
          : { result: "reject", reason: body.reason || "rejected in the UI" },
      );
      json(res, 202, { ok: true });
      return;
    }

    const retryMatch = /^\/api\/runs\/([A-Za-z0-9_-]+)\/retry$/.exec(url.pathname);
    if (req.method === "POST" && retryMatch) {
      await service.retry(retryMatch[1]!);
      json(res, 202, { ok: true });
      return;
    }

    // --- artifacts (for reviewing a script before approving it) ---
    const artMatch = /^\/api\/artifacts\/(sha256:[0-9a-f]{64})$/.exec(
      decodeURIComponent(url.pathname),
    );
    if (req.method === "GET" && artMatch) {
      json(res, 200, { artifact: await service.artifact(artMatch[1]!) });
      return;
    }

    json(res, 404, { error: `no route for ${route}` });
  }

  return {
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(port, host, () => resolve(`http://${host}:${port}`));
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // Nothing here should ever be cached, least of all credential status.
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
