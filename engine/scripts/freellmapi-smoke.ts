/**
 * Pre-flight probe for the reasoning route used by the RFC 0010 live benchmark.
 *
 * Production text is free-only with an ordered fallback chain and no paid
 * fallback (see engine/src/llm-routing.ts). This probe mirrors that exactly:
 *
 *  - walk the configured chain of concrete free model ids in order;
 *  - a transient 429 / 5xx / transport error gets a bounded retry on the SAME
 *    model, honouring a "cooldown reset ~Nm" hint, capped per-wait and in total;
 *  - a 404 / model_not_found (or retry-exhausted) moves on to the NEXT model;
 *  - a 401 / 403 is an auth failure and ends the probe immediately;
 *  - the probe passes as soon as ANY model answers, and fails only when EVERY
 *    configured model is unavailable.
 *
 * No model id is ever rewritten to `auto`.
 */

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SmokeOptions {
  /** Ordered chain of concrete free models. Never empty. */
  models: Endpoint[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
  /** Attempts per model before moving to the next (1 = no retry). Default 2. */
  maxAttemptsPerModel?: number;
  /** Upper bound on any single backoff wait. Default 30_000. */
  perWaitCapMs?: number;
  /** Upper bound on the summed backoff waits across the whole chain. Default 60_000. */
  totalWaitCapMs?: number;
}

export interface SmokeResult {
  /** "platform/model" (or model id) that actually answered. */
  routedVia: string;
  /** The configured model id that answered. */
  model: string;
  /** Attempts against the model that answered. */
  attempts: number;
  /** Configured model ids that were tried and skipped before this one, with reasons. */
  skipped: string[];
}

export class SmokeError extends Error {
  override name = "SmokeError";
}

const BODY_SLICE = 240;

/** Parse "Soonest cooldown reset ~10m" / "~90s" / "~500ms" into ms; undefined when absent. */
export function parseCooldownMs(body: string): number | undefined {
  const match = /(?:cooldown\s+reset|reset)\s*~?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)\b/i.exec(body);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = match[2]!.toLowerCase();
  if (unit === "ms") return value;
  if (unit.startsWith("s")) return value * 1_000;
  return value * 60_000;
}

function backoffMs(attempt: number, capMs: number): number {
  return Math.min(2_000 * 2 ** (attempt - 1), capMs);
}

function routedVia(res: Response, json: Record<string, unknown>, fallback: string): string {
  const header = res.headers.get("x-routed-via");
  if (header) return header;
  const routed = json["_routed_via"] as { platform?: string; model?: string } | undefined;
  if (routed?.model) return routed.platform ? `${routed.platform}/${routed.model}` : routed.model;
  return typeof json["model"] === "string" ? (json["model"] as string) : fallback;
}

type Probe =
  | { kind: "ok"; via: string }
  | { kind: "retry"; status: number | "transport"; body: string }
  | { kind: "next"; message: string }
  | { kind: "auth"; message: string };

async function probeOnce(endpoint: Endpoint, fetchImpl: typeof fetch): Promise<Probe> {
  let res: Response;
  try {
    res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
      // No reasoning_effort override: some models reject reasoning_effort:"none".
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: "user", content: "Reply with exactly OK" }],
        max_completion_tokens: 800,
      }),
    });
  } catch (err) {
    return { kind: "retry", status: "transport", body: String(err) };
  }

  if (res.ok) {
    const json = (await res.json()) as Record<string, unknown>;
    const choices = json["choices"] as unknown[] | undefined;
    if (!choices?.length) return { kind: "next", message: "route answered with no choices" };
    return { kind: "ok", via: routedVia(res, json, endpoint.model) };
  }

  const body = (await res.text()).slice(0, 400);
  if (res.status === 401 || res.status === 403) return { kind: "auth", message: `HTTP ${res.status}: ${body}` };
  if (res.status === 404 || /not found|removed upstream|unknown model|no candidate model|usable provider key/i.test(body)) {
    return { kind: "next", message: `HTTP ${res.status}: ${body}` };
  }
  if (res.status === 429 || res.status >= 500) return { kind: "retry", status: res.status, body };
  return { kind: "next", message: `HTTP ${res.status}: ${body}` };
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = opts.logger ?? console;
  const maxAttempts = Math.max(1, opts.maxAttemptsPerModel ?? 2);
  const perWaitCapMs = Math.max(0, opts.perWaitCapMs ?? 30_000);
  const totalWaitCapMs = Math.max(0, opts.totalWaitCapMs ?? 60_000);

  if (opts.models.length === 0) throw new SmokeError("no free text models configured to probe");

  const skipped: string[] = [];
  let waitedMs = 0;

  for (const endpoint of opts.models) {
    let lastDetail = "exhausted attempts";
    let moveOn = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const probe = await probeOnce(endpoint, fetchImpl);

      if (probe.kind === "ok") {
        logger.log(`[freellmapi-smoke] free text chain ready via ${probe.via} (model ${endpoint.model}, attempt ${attempt})`);
        return { routedVia: probe.via, model: endpoint.model, attempts: attempt, skipped };
      }
      if (probe.kind === "auth") {
        throw new SmokeError(`FreeLLMAPI auth failed: ${probe.message}`);
      }
      if (probe.kind === "next") {
        lastDetail = probe.message;
        moveOn = true;
        break;
      }

      lastDetail = `${probe.status}: ${probe.body.slice(0, BODY_SLICE)}`;
      if (attempt >= maxAttempts) break;

      const hinted = probe.status === 429 ? parseCooldownMs(probe.body) : undefined;
      let wait = Math.min(hinted ?? backoffMs(attempt, perWaitCapMs), perWaitCapMs);
      wait = Math.min(wait, Math.max(0, totalWaitCapMs - waitedMs));
      if (wait <= 0) break;
      logger.warn(`[freellmapi-smoke] ${endpoint.model} ${probe.status} (attempt ${attempt}/${maxAttempts}); waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      waitedMs += wait;
    }

    skipped.push(`${endpoint.model} (${lastDetail})`);
    if (!moveOn) {
      logger.warn(`[freellmapi-smoke] ${endpoint.model} unavailable after ${maxAttempts} attempt(s); trying next model`);
    } else {
      logger.warn(`[freellmapi-smoke] ${endpoint.model} skipped: ${lastDetail}`);
    }
  }

  throw new SmokeError(`every configured free text model is unavailable: ${skipped.join("; ")}`);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveSmokeModels(env: NodeJS.ProcessEnv = process.env): Endpoint[] {
  const apiKey = clean(env["FREELLMAPI_API_KEY"]);
  if (!apiKey) throw new SmokeError("FREELLMAPI_API_KEY is not set");
  const baseUrl = clean(env["FREELLMAPI_BASE_URL"]) ?? "http://freellmapi:3001/v1";
  const raw = clean(env["FREELLMAPI_TEXT_MODELS"])
    ?? clean(env["FREELLMAPI_TEXT_MODEL"])
    ?? "gpt-oss-120b,llama-3.3-70b-fp8-fast,nemotron-3-super-120b,gpt-oss-20b";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new SmokeError("FREELLMAPI_TEXT_MODELS resolved to an empty list");
  for (const id of ids) {
    if (/^auto(?::|$)/i.test(id)) throw new SmokeError(`FREELLMAPI_TEXT_MODELS may not contain auto routing ('${id}')`);
  }
  return ids.map((model) => ({ baseUrl, apiKey, model }));
}

async function main(): Promise<void> {
  const result = await runSmoke({ models: resolveSmokeModels() });
  console.log(`[freellmapi-smoke] routed via ${result.routedVia} (model ${result.model}); ${result.skipped.length} earlier model(s) skipped`);
}

// Run only as a CLI, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("freellmapi-smoke.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
