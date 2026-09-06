/**
 * Pre-flight probe for the shared FreeLLMAPI text route used by the RFC 0010
 * live benchmark.
 *
 * It verifies auth + network + that the pinned Gemini model resolves and
 * actually answers, and logs the router's `X-Routed-Via` so an unexpected
 * silent fallback is visible before a 120-minute benchmark starts.
 *
 * Resilience: the shared key is quota-limited and periodically returns a
 * transient 429 while it recovers. A single 429 must not destroy the whole
 * benchmark workflow, so a rate-limit / 5xx is retried a bounded number of
 * times, honouring the router's "cooldown reset ~Nm" hint capped to a sane
 * per-wait and total budget. Genuine auth / model errors (401/403/404) fail
 * immediately and are never turned into success. The pinned model is never
 * swapped for `auto`; this probe only decides whether to wait and retry.
 */

export interface SmokeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
  /** Total probe attempts (1 = no retry). Default 5. */
  maxAttempts?: number;
  /** Upper bound on any single backoff wait. Default 240_000 (4 min). */
  perWaitCapMs?: number;
  /** Upper bound on the summed backoff waits across the whole probe. Default 720_000 (12 min). */
  totalWaitCapMs?: number;
}

export class SmokeError extends Error {
  override name = "SmokeError";
}

const RETRYABLE_BODY_SLICE = 200;

/**
 * Parse the router's "Soonest cooldown reset ~10m" / "~90s" hint into ms.
 * Returns undefined when no hint is present so the caller falls back to
 * exponential backoff.
 */
export function parseCooldownMs(body: string): number | undefined {
  const match = /cooldown\s+reset\s*~?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)/i.exec(body);
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

function routedVia(res: Response, json: Record<string, unknown>): string {
  const header = res.headers.get("x-routed-via");
  if (header) return header;
  const routed = json["_routed_via"] as { platform?: string; model?: string } | undefined;
  if (routed?.model) return routed.platform ? `${routed.platform}/${routed.model}` : routed.model;
  return typeof json["model"] === "string" ? (json["model"] as string) : "unknown";
}

export async function runSmoke(opts: SmokeOptions): Promise<{ routedVia: string; attempts: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = opts.logger ?? console;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const perWaitCapMs = Math.max(0, opts.perWaitCapMs ?? 240_000);
  const totalWaitCapMs = Math.max(0, opts.totalWaitCapMs ?? 720_000);

  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let waitedMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "user", content: "Reply with exactly OK" }],
          max_completion_tokens: 16,
          reasoning_effort: "none",
        }),
      });
    } catch (err) {
      // Transport failure: treat like a 5xx for retry purposes.
      if (attempt >= maxAttempts) {
        throw new SmokeError(`FreeLLMAPI unreachable after ${attempt} attempt(s): ${String(err)}`);
      }
      const wait = Math.min(backoffMs(attempt, perWaitCapMs), Math.max(0, totalWaitCapMs - waitedMs));
      if (wait <= 0) throw new SmokeError(`FreeLLMAPI unreachable and retry budget exhausted: ${String(err)}`);
      logger.warn(`[freellmapi-smoke] transport error (attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      waitedMs += wait;
      continue;
    }

    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      const choices = json["choices"] as unknown[] | undefined;
      if (!choices?.length) throw new SmokeError("FreeLLMAPI returned no choices");
      const via = routedVia(res, json);
      if (!/gemini/i.test(via)) {
        // The pin exists precisely so text never silently drops to another
        // model. A successful answer from a non-Gemini route is not an
        // acceptable pre-flight result.
        throw new SmokeError(`FreeLLMAPI answered via unexpected route "${via}"; expected the pinned Gemini model`);
      }
      logger.log(`[freellmapi-smoke] pinned Gemini route ready via ${via} (attempt ${attempt})`);
      return { routedVia: via, attempts: attempt };
    }

    const body = (await res.text()).slice(0, 400);
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new SmokeError(`FreeLLMAPI ${res.status}: ${body}`);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new SmokeError(`FreeLLMAPI ${res.status}: ${body}`);
    if (attempt >= maxAttempts) {
      throw new SmokeError(`FreeLLMAPI still rate-limited/unavailable after ${attempt} attempt(s): ${res.status}: ${body.slice(0, RETRYABLE_BODY_SLICE)}`);
    }

    const hinted = res.status === 429 ? parseCooldownMs(body) : undefined;
    let wait = Math.min(hinted ?? backoffMs(attempt, perWaitCapMs), perWaitCapMs);
    wait = Math.min(wait, Math.max(0, totalWaitCapMs - waitedMs));
    if (wait <= 0) {
      throw new SmokeError(`FreeLLMAPI ${res.status} and retry budget exhausted: ${body.slice(0, RETRYABLE_BODY_SLICE)}`);
    }
    logger.warn(
      `[freellmapi-smoke] FreeLLMAPI ${res.status} (attempt ${attempt}/${maxAttempts})` +
        `${hinted ? ` cooldown hint ~${Math.round(hinted / 1000)}s` : ""}; waiting ${Math.round(wait / 1000)}s before retry`,
    );
    await sleep(wait);
    waitedMs += wait;
  }

  // Unreachable: the loop either returns or throws.
  throw new SmokeError("FreeLLMAPI smoke probe exhausted attempts");
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function main(): Promise<void> {
  const apiKey = clean(process.env["FREELLMAPI_API_KEY"]);
  const model = clean(process.env["FREELLMAPI_TEXT_MODEL"]) ?? "gemini-3.5-flash";
  const baseUrl = clean(process.env["FREELLMAPI_BASE_URL"]) ?? "http://freellmapi:3001/v1";
  if (!apiKey) throw new SmokeError("FREELLMAPI_API_KEY is not set");
  if (/^auto(?::|$)/i.test(model) || !/gemini/i.test(model)) {
    throw new SmokeError(`FREELLMAPI_TEXT_MODEL must be a concrete Gemini model; got "${model}"`);
  }
  await runSmoke({ baseUrl, apiKey, model });
}

// Run only as a CLI, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("freellmapi-smoke.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
