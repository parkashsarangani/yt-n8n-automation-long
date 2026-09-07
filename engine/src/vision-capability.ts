/**
 * Process-local capability canary for a vision endpoint.
 *
 * A HTTP 200 is not proof that a routed model actually received image pixels:
 * the shared FreeLLMAPI `auto:smart` route was observed dropping images and
 * answering from prompt text through a text-only model. This canary asks the
 * endpoint to read a known four-digit image before any real visual QA result is
 * trusted. The result is cached for the process/run and is intentionally
 * endpoint+model scoped.
 */

const CANARY_NUMBER = "7391";
const CANARY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaAQAAAAAXvWD/AAABI0lEQVR42u2UPVKFMBhFTyDz3quU0k6WYGkHy7IzpYuyyBLeEmJnyVhFJ3AtIPwMr9AeOs6ckPvdZDBi/xQc8IBb2JsWPqpMJaAJnCVKKRpJ8/IfRA9vGxMleB3YmLgEfrd7hLCBJuG7s99Eau9K4OGp4zRBCSrcKL0spgMI9SUal6H+PrsBaIG0wGH+7NosoF/TYlwkayDEtWmBE/XGzMLndSlZ3b0GjAKUGnJ1HYCoboR3lw0MFSbh7c4socSuYQ24gH+2C/TT6M372mxvtOR23UlCkvzjOMUUXoDH5ymm5QauOCKhmuEAfPXU37SoUDGHlwVMbq+ANF2IVTYplpIDdaABzFidzSdqlt0j0HLiMl6kKbykRCPRjC8yx6/ygP+Hvx5ai9gqIqMEAAAAAElFTkSuQmCC";

export type VisionCanaryFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface CanaryEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
  timeoutMs?: number;
}

const cached = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean>>();

function cacheKey(endpoint: CanaryEndpoint): string {
  return `${endpoint.baseUrl.replace(/\/$/, "")}|${endpoint.model}`;
}

async function runCanary(endpoint: CanaryEndpoint, fetchImpl: VisionCanaryFetch): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs = endpoint.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Read the four black digits in the attached image. Do not infer from this instruction. Respond ONLY JSON: {\"number\":\"${CANARY_NUMBER}\",\"saw_image\":true}`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${CANARY_PNG_BASE64}`, detail: "low" },
            },
          ],
        }],
        max_completion_tokens: 80,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[vision-capability] ${endpoint.label} canary failed: HTTP ${res.status}`);
      return false;
    }
    const payload = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = payload.choices?.[0]?.message?.content;
    if (typeof raw !== "string") {
      console.warn(`[vision-capability] ${endpoint.label} canary returned no message content`);
      return false;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const ok = parsed["saw_image"] === true && String(parsed["number"] ?? "").trim() === CANARY_NUMBER;
      if (!ok) {
        console.warn(`[vision-capability] ${endpoint.label} failed pixel canary; route will not be trusted for vision this run`);
      }
      return ok;
    } catch {
      console.warn(`[vision-capability] ${endpoint.label} canary returned invalid JSON`);
      return false;
    }
  } catch (err) {
    console.warn(`[vision-capability] ${endpoint.label} canary failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Run once per endpoint+model per process. A failed canary is sticky for the run. */
export async function ensureVisionCapability(
  endpoint: CanaryEndpoint,
  fetchImpl: VisionCanaryFetch = fetch as unknown as VisionCanaryFetch,
): Promise<boolean> {
  const key = cacheKey(endpoint);
  const known = cached.get(key);
  if (known !== undefined) return known;
  const running = inflight.get(key);
  if (running) return running;
  const promise = runCanary(endpoint, fetchImpl).then((ok) => {
    cached.set(key, ok);
    inflight.delete(key);
    return ok;
  }, (err) => {
    inflight.delete(key);
    cached.set(key, false);
    throw err;
  });
  inflight.set(key, promise);
  return promise;
}

/** Test hook. */
export function resetVisionCapability(): void {
  cached.clear();
  inflight.clear();
}
