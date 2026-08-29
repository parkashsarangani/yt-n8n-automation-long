// Checks a generated AI b-roll image for the one class of defect the house
// style explicitly forbids but the image model sometimes produces anyway:
// visible text, lettering, logos, or watermarks baked into the artwork (see
// HOUSE_STYLE in hybrid-visual-assets.ts: "no words, no letters, no
// captions, no logos, no watermark"). Confirmed in production
// (run_ad5bd430, onions episode): a generated knife prop carried fake
// engraved lettering ("ID ohrimi") that nothing in the pipeline rejected,
// even though the prompt explicitly forbade it.
//
// Uses OpenAI's vision-capable chat completions endpoint directly (the same
// OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL env vars as
// providers/openai.ts) rather than routing through the ModelProvider
// abstraction: workers are deliberately given no model access (see
// runner.test.ts, "workers run through the same harness and are given no
// model") -- this is a narrowly-scoped, self-contained capability in that
// same spirit as icon-search.ts, not a general completion channel.
//
// Every failure mode (missing API key, network error, timeout, malformed
// response) resolves to `{ hasVisibleText: false }` -- i.e. "pass" -- never
// a thrown error. A QA check that can silently fail-closed and block
// episode generation is worse than one that occasionally misses a real
// defect; the existing regenerate-then-fall-back-to-motion-graphic path
// already tolerates an occasional bad image, it does not tolerate the whole
// pipeline blocking because a QA call timed out.

const TIMEOUT_MS = 12000;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ImageQaResult {
  hasVisibleText: boolean;
  reason: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // btoa is a global in both browsers and modern Node -- avoids a Buffer
  // dependency for a module that otherwise has none.
  return btoa(binary);
}

/**
 * Returns null (not a boolean) when the check could not run at all -- the
 * caller treats null the same as a pass (image is used unchanged), but the
 * distinction is preserved in logging so a persistent misconfiguration
 * (missing API key) is visible instead of silently indistinguishable from
 * "every image is clean".
 */
export async function checkGeneratedImageForText(
  image: { bytes: Uint8Array; media_type: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ImageQaResult | null> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const baseUrl = (process.env["OPENAI_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env["OPENAI_IMAGE_QA_MODEL"] ?? process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const dataUri = `data:${image.media_type};base64,${base64FromBytes(image.bytes)}`;
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: "This image must contain no readable text, letters, numbers, logos, or watermarks anywhere in it -- not on props, signage, packaging, or as a texture/pattern. Look closely at any engraved, printed, or embossed marks on objects. Respond with only this JSON, no other text: {\"has_visible_text\": true or false, \"reason\": \"one short sentence\"}",
            },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        }],
        max_completion_tokens: 200,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content) as { has_visible_text?: unknown; reason?: unknown };
    if (typeof parsed.has_visible_text !== "boolean") return null;
    return { hasVisibleText: parsed.has_visible_text, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    // Network error, timeout (AbortError), or malformed JSON -- all the same
    // outcome: the check didn't run, the image is used as generated.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
