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

export interface SemanticQaResult {
  /**
   * True only when the image actively depicts something the narration does
   * NOT claim -- a literal misreading of a figurative line, a wrong causal
   * direction, an object doing something the script never said. Deliberately
   * NOT "is this image a perfect illustration": b-roll is allowed to be
   * atmospheric, partial, or oblique, and rejecting merely-loose imagery
   * would reject most of what the pipeline legitimately produces.
   */
  contradictsNarration: boolean;
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
 * Shared vision call. Returns the parsed JSON object the model produced, or
 * null when the check could not run at all (no API key, network error,
 * timeout, non-JSON response). Callers treat null as "check did not run" and
 * pass the image through -- see the module comment on why a QA check must
 * never fail closed.
 */
async function askVision(
  image: { bytes: Uint8Array; media_type: string },
  instruction: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown> | null> {
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
            { type: "text", text: instruction },
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
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    // Network error, timeout (AbortError), or malformed JSON -- all the same
    // outcome: the check didn't run, the image is used as generated.
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  const parsed = await askVision(
    image,
    "This image must contain no readable text, letters, numbers, logos, or watermarks anywhere in it -- not on props, signage, packaging, or as a texture/pattern. Look closely at any engraved, printed, or embossed marks on objects. Respond with only this JSON, no other text: {\"has_visible_text\": true or false, \"reason\": \"one short sentence\"}",
    fetchImpl,
  );
  if (!parsed || typeof parsed["has_visible_text"] !== "boolean") return null;
  return { hasVisibleText: parsed["has_visible_text"], reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "" };
}

/**
 * Checks whether an image actively CONTRADICTS the line it illustrates.
 *
 * Motivating production defect (run_ad5bd430, onions episode): over
 * narration about preventing an irritant from reaching the eyes, the image
 * model rendered a glowing beam running between the two characters' eyes --
 * stylistically on-model, no text, but explanatorily wrong, so the existing
 * text-only gate passed it. This is exactly the class of defect a human
 * storyboard review catches and schema validation never can.
 *
 * The bar is deliberately "contradicts", not "illustrates well". B-roll is
 * legitimately atmospheric, partial, and oblique; a check that demanded a
 * faithful illustration would reject most of what the pipeline correctly
 * produces, and a QA gate with a high false-positive rate is worse than
 * none -- it would push good scenes down the fallback path and make episodes
 * MORE generic, the opposite of the goal. The prompt therefore states the
 * asymmetry explicitly and tells the model to answer false when unsure.
 */
export async function checkGeneratedImageMatchesNarration(
  image: { bytes: Uint8Array; media_type: string },
  narration: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SemanticQaResult | null> {
  const line = narration.trim().slice(0, 400);
  if (!line) return null;
  const parsed = await askVision(
    image,
    `This image is b-roll illustrating this spoken line from an explainer video: "${line}"\n\n`
    + "Decide ONLY whether the image actively contradicts or misrepresents that line -- for example, taking a figurative phrase literally, showing the causal direction backwards, or depicting an event the line never describes.\n\n"
    + "Do NOT flag an image merely for being atmospheric, abstract, partial, stylised, or a loose association. B-roll is not required to be a literal illustration. If you are unsure, answer false.\n\n"
    + "Respond with only this JSON, no other text: {\"contradicts_narration\": true or false, \"reason\": \"one short sentence\"}",
    fetchImpl,
  );
  if (!parsed || typeof parsed["contradicts_narration"] !== "boolean") return null;
  return { contradictsNarration: parsed["contradicts_narration"], reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "" };
}
