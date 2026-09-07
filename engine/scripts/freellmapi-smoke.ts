/**
 * Pre-flight probe for the reasoning route used by the RFC 0010 live benchmark.
 *
 * It verifies auth + network + that the pinned Gemini model on the shared
 * FreeLLMAPI actually answers, and logs the router's `X-Routed-Via` so a silent
 * downgrade is visible before a 120-minute benchmark starts.
 *
 * Resilience matches the runtime routing contract, it does not widen it:
 *
 *  - `LLM_ROUTER_MODE=freellmapi` tries the pinned Gemini model first;
 *  - a transient 429 / 5xx / transport error is retried with bounded backoff,
 *    honouring the router's "cooldown reset ~Nm" hint, capped per-wait and in
 *    total so a genuine sustained outage still ends the probe;
 *  - if Gemini is still rate-limited after the retry budget AND
 *    `LLM_ROUTER_FAIL_OPEN_TO_DIRECT` is enabled AND a direct key is configured,
 *    the probe verifies the *fail-open* route instead and lets the benchmark
 *    start in the exact degraded mode the runtime would itself use, logging a
 *    loud warning that text artifacts will be attributed to the fail-open
 *    provider rather than the pinned Gemini model;
 *  - 401 / 403 / 404 (auth, missing model) always fail immediately;
 *  - the pinned model string is never rewritten to `auto`.
 */

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SmokeOptions {
  primary: Endpoint;
  /** Direct fail-open route, mirrored from runtime. Only used when the primary is rate-limited. */
  failOpen?: Endpoint;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
  /** Total primary attempts (1 = no retry). Default 5. */
  maxAttempts?: number;
  /** Upper bound on any single backoff wait. Default 240_000 (4 min). */
  perWaitCapMs?: number;
  /** Upper bound on the summed backoff waits. Default 720_000 (12 min). */
  totalWaitCapMs?: number;
}

export interface SmokeResult {
  routedVia: string;
  attempts: number;
  /** true when the pinned Gemini route was unavailable and the fail-open route was used. */
  degraded: boolean;
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
  return Math.min(30_000 * 2 ** (attempt - 1), capMs);
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
  | { kind: "fatal"; message: string };

async function probeOnce(endpoint: Endpoint, fetchImpl: typeof fetch): Promise<Probe> {
  let res: Response;
  try {
    res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
      // No reasoning_effort override: some Google flash models now reject
      // reasoning_effort:"none". 800 tokens is ample headroom for a thinking
      // model to still emit "OK" and is a negligible cost.
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
    if (!choices?.length) return { kind: "fatal", message: "route answered with no choices" };
    return { kind: "ok", via: routedVia(res, json, endpoint.model) };
  }

  const body = (await res.text()).slice(0, 400);
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { kind: "fatal", message: `HTTP ${res.status}: ${body}` };
  }
  if (res.status === 429 || res.status >= 500) {
    return { kind: "retry", status: res.status, body };
  }
  return { kind: "fatal", message: `HTTP ${res.status}: ${body}` };
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = opts.logger ?? console;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const perWaitCapMs = Math.max(0, opts.perWaitCapMs ?? 240_000);
  const totalWaitCapMs = Math.max(0, opts.totalWaitCapMs ?? 720_000);

  let waitedMs = 0;
  let lastRetry: { status: number | "transport"; body: string } | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await probeOnce(opts.primary, fetchImpl);

    if (probe.kind === "ok") {
      if (!/gemini/i.test(probe.via)) {
        // The pin exists so text never silently drops to another model on the
        // primary route. A non-Gemini answer here is a real routing problem.
        throw new SmokeError(`FreeLLMAPI answered via unexpected route "${probe.via}"; expected the pinned Gemini model`);
      }
      logger.log(`[freellmapi-smoke] pinned Gemini route ready via ${probe.via} (attempt ${attempt})`);
      return { routedVia: probe.via, attempts: attempt, degraded: false };
    }

    if (probe.kind === "fatal") {
      throw new SmokeError(`FreeLLMAPI ${probe.message}`);
    }

    lastRetry = { status: probe.status, body: probe.body };
    if (attempt >= maxAttempts) break;

    const hinted = probe.status === 429 ? parseCooldownMs(probe.body) : undefined;
    let wait = Math.min(hinted ?? backoffMs(attempt, perWaitCapMs), perWaitCapMs);
    wait = Math.min(wait, Math.max(0, totalWaitCapMs - waitedMs));
    if (wait <= 0) break;
    logger.warn(
      `[freellmapi-smoke] primary ${probe.status} (attempt ${attempt}/${maxAttempts})` +
        `${hinted ? ` cooldown hint ~${Math.round(hinted / 1000)}s` : ""}; waiting ${Math.round(wait / 1000)}s`,
    );
    await sleep(wait);
    waitedMs += wait;
  }

  const detail = lastRetry ? `${lastRetry.status}: ${lastRetry.body.slice(0, BODY_SLICE)}` : "exhausted attempts";

  // Mirror runtime: a sustained primary rate-limit is survivable iff the
  // configured fail-open route is. Auth/model failures never reach here.
  if (opts.failOpen) {
    logger.warn(
      `[freellmapi-smoke] pinned Gemini route unavailable after ${maxAttempts} attempt(s) (${detail}); ` +
        `verifying the configured fail-open route (${opts.failOpen.model})`,
    );
    const fo = await probeOnce(opts.failOpen, fetchImpl);
    if (fo.kind === "ok") {
      logger.warn(
        `[freellmapi-smoke] DEGRADED: benchmark will start on the fail-open route "${fo.via}". ` +
          `Text artifacts will be attributed to the fail-open provider, not the pinned Gemini model. ` +
          `Re-run once the shared FreeLLMAPI Gemini quota has recovered for a fully production-scoped benchmark.`,
      );
      return { routedVia: fo.via, attempts: maxAttempts, degraded: true };
    }
    const foDetail = fo.kind === "fatal" ? fo.message : `${fo.status}: ${fo.body.slice(0, BODY_SLICE)}`;
    throw new SmokeError(
      `pinned Gemini route unavailable (${detail}) and fail-open route also failed (${foDetail})`,
    );
  }

  throw new SmokeError(`pinned Gemini route unavailable after ${maxAttempts} attempt(s) and no fail-open route is configured (${detail})`);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  const v = clean(value)?.toLowerCase();
  if (v === undefined) return fallback;
  return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}

async function main(): Promise<void> {
  const apiKey = clean(process.env["FREELLMAPI_API_KEY"]);
  const model = clean(process.env["FREELLMAPI_TEXT_MODEL"]) ?? "gemini-3.5-flash";
  const baseUrl = clean(process.env["FREELLMAPI_BASE_URL"]) ?? "http://freellmapi:3001/v1";
  if (!apiKey) throw new SmokeError("FREELLMAPI_API_KEY is not set");
  if (/^auto(?::|$)/i.test(model) || !/gemini/i.test(model)) {
    throw new SmokeError(`FREELLMAPI_TEXT_MODEL must be a concrete Gemini model; got "${model}"`);
  }

  const directKey = clean(process.env["OPENAI_API_KEY"]);
  const failOpenEnabled = boolEnv(process.env["LLM_ROUTER_FAIL_OPEN_TO_DIRECT"], true);
  const routerMode = clean(process.env["LLM_ROUTER_MODE"])?.toLowerCase() ?? "freellmapi";
  const failOpen: Endpoint | undefined =
    routerMode !== "direct" && failOpenEnabled && directKey
      ? {
          baseUrl: clean(process.env["OPENAI_BASE_URL"]) ?? "https://api.openai.com/v1",
          apiKey: directKey,
          model: clean(process.env["OPENAI_MODEL"]) ?? "gpt-5.6-luna",
        }
      : undefined;

  const result = await runSmoke({ primary: { baseUrl, apiKey, model }, ...(failOpen ? { failOpen } : {}) });
  if (!result.degraded) return;
  // degraded but usable: exit 0 so the benchmark proceeds under the runtime's
  // own fail-open behaviour; the warning above and the benchmark report's
  // provider attribution make the downgrade explicit.
}

// Run only as a CLI, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("freellmapi-smoke.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
