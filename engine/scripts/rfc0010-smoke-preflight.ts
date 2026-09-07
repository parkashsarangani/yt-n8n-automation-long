import { runSmoke, SmokeError, type Endpoint } from "./freellmapi-smoke.ts";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  return !["false", "0", "off", "no"].includes(normalized);
}

async function main(): Promise<void> {
  const apiKey = clean(process.env["FREELLMAPI_API_KEY"]);
  const model = clean(process.env["FREELLMAPI_TEXT_MODEL"]) ?? "gemini-3.5-flash";
  if (!apiKey) throw new SmokeError("FREELLMAPI_API_KEY is not set");
  if (/^auto(?::|$)/i.test(model) || !/gemini/i.test(model)) {
    throw new SmokeError(`FREELLMAPI_TEXT_MODEL must be a concrete Gemini model; got "${model}"`);
  }

  const primary: Endpoint = {
    baseUrl: clean(process.env["FREELLMAPI_BASE_URL"]) ?? "http://freellmapi:3001/v1",
    apiKey,
    model,
  };
  const directKey = clean(process.env["OPENAI_API_KEY"]);
  const failOpenEnabled = enabled(process.env["LLM_ROUTER_FAIL_OPEN_TO_DIRECT"], true);
  const routerMode = clean(process.env["LLM_ROUTER_MODE"])?.toLowerCase() ?? "freellmapi";
  const failOpen: Endpoint | undefined = routerMode !== "direct" && failOpenEnabled && directKey
    ? {
        baseUrl: clean(process.env["OPENAI_BASE_URL"]) ?? "https://api.openai.com/v1",
        apiKey: directKey,
        model: clean(process.env["OPENAI_MODEL"]) ?? "gpt-5.6-luna",
      }
    : undefined;

  const result = await runSmoke({
    primary,
    ...(failOpen ? { failOpen } : {}),
    maxAttempts: 2,
    perWaitCapMs: 30_000,
    totalWaitCapMs: 30_000,
  });
  console.log(`[rfc0010-smoke-preflight] route=${result.routedVia} degraded=${result.degraded} attempts=${result.attempts}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
