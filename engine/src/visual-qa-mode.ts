/**
 * Whether real, paid, pixel-inspecting vision QA is allowed this run.
 *
 * Default: NO.
 *
 * A normal automated run judges visuals with a text-only metadata semantic
 * proxy (see `metadata-semantic-gate.ts`) and never spends on OpenAI vision.
 * The proxy reads the narration, beat requirements, generation prompt / stock
 * query and asset metadata we already possess and answers "is this asset
 * semantically likely to match the beat?" — it is sourcing-intent screening,
 * not visual verification, and it never claims a pixel was inspected.
 *
 * Real vision QA (direct OpenAI, guarded by the read-the-number canary) runs
 * ONLY when `VISUAL_QA_MODE` is explicitly set to a truthy/`real` value — the
 * manual benchmark and live-media-smoke workflows do this. There is no
 * automatic escalation from the proxy into paid vision.
 */
export function realVisionQaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on|real)$/i.test((env["VISUAL_QA_MODE"] ?? "").trim());
}
