/**
 * Free Media Bake-off — manual, workflow_dispatch only.
 *
 * Empirically proves candidate FREE image/video models on the shared FreeLLMAPI
 * media gateway. One difficult narration-style prompt per model. Writes the
 * generated media plus `media-bakeoff-report.json` to an output directory for
 * human inspection; a `.mp4` extension alone is never treated as validation.
 *
 * This script calls ONLY the explicit FreeLLMAPI image/video model ids it is
 * given. It never touches fal / Kling, and never triggers the RFC 0010
 * benchmark. `PAID_VIDEO_FALLBACK` is forced to `false` for the process.
 *
 *   node --import tsx scripts/free-media-smoke.ts \
 *     --image "flux,black-forest-labs/flux.2-klein-4b" \
 *     --video "" \
 *     --out ./media-bakeoff
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FreeLlmImageProvider } from "../src/providers/freellm-image.ts";
import { FreeLlmVideoProvider } from "../src/providers/freellm-video.ts";
import { assertConcreteMediaModels } from "../src/freellm-media-models.ts";
import { isDailyFreeImageCapacityMessage, isFreeMediaAuthFailure } from "../src/free-media-policy.ts";

process.env["PAID_VIDEO_FALLBACK"] = "false";

const IMAGE_PROMPT =
  "Photorealistic documentary-style scene inside a modern European train station. "
  + "A commuter is walking toward a train platform while holding a smartphone and visibly "
  + "interacting with a navigation route on the screen. Natural daylight, realistic human "
  + "anatomy and object scale, candid framing, no logos, no captions, no watermark, no "
  + "decorative sci-fi elements.";

const VIDEO_PROMPT =
  "Documentary-style shot in a modern European train station. A commuter walks toward the "
  + "platform, looks at a smartphone navigation route, taps the phone, then continues toward "
  + "the arriving train. Natural human movement, realistic phone scale, stable camera, no "
  + "captions, no logo, no surreal effects.";

// Three independent dimensions. A broken credential or an exhausted daily free
// quota must NOT be reported as "this model costs money".
type Availability = "AVAILABLE" | "QUOTA_EXHAUSTED" | "AUTH_ERROR" | "BROKEN";
type Cost = "FREE" | "PAID_ONLY" | "UNKNOWN";
type Quality = "PASS" | "FAIL" | "UNKNOWN";

interface Attempt {
  modality: "image" | "video";
  requested_model: string;
  routed_provider: string | null;
  routed_model: string | null;
  status: "success" | "failed";
  http_status: number | null;
  latency_ms: number;
  content_type: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  codec: string | null;
  failure_reason: string | null;
  availability: Availability;
  cost: Cost;
  quality: Quality;
  /** Only a model that is AVAILABLE + FREE + quality PASS may be promoted. */
  promotable: boolean;
  artifact: string | null;
}

function classifyFailure(err: unknown, reason: string): { availability: Availability; cost: Cost } {
  if (isFreeMediaAuthFailure(err) || /rejected the unified key|invalid api key|\b40[13]\b/i.test(reason)) {
    return { availability: "AUTH_ERROR", cost: "UNKNOWN" };
  }
  if (isDailyFreeImageCapacityMessage(err) || /daily free allocation|daily .*quota/i.test(reason)) {
    return { availability: "QUOTA_EXHAUSTED", cost: "FREE" };
  }
  if (/not a free route|payment required|top ?up|insufficient .*balance|paid[_ -]?only|out of credits|billing/i.test(reason)) {
    return { availability: "AVAILABLE", cost: "PAID_ONLY" };
  }
  return { availability: "BROKEN", cost: "UNKNOWN" };
}

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function sanitize(model: string): string {
  return model.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "model";
}

function pngJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const m = bytes[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: (bytes[i + 7]! << 8) | bytes[i + 8]!, height: (bytes[i + 5]! << 8) | bytes[i + 6]! };
      }
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

async function bakeImage(model: string, outDir: string): Promise<Attempt> {
  const started = Date.now();
  const base: Attempt = {
    modality: "image", requested_model: model, routed_provider: null, routed_model: null,
    status: "failed", http_status: null, latency_ms: 0, content_type: null, bytes: 0,
    width: null, height: null, duration_sec: null, codec: null, failure_reason: null,
    availability: "BROKEN", cost: "UNKNOWN", quality: "UNKNOWN", promotable: false, artifact: null,
  };
  try {
    const provider = new FreeLlmImageProvider({ models: [model] });
    const out = await provider.generate({ prompt: IMAGE_PROMPT, aspect: "16:9" });
    const image = out.images[0]!;
    const dims = pngJpegDimensions(image.bytes);
    const ext = image.media_type.split("/")[1]?.replace("jpeg", "jpg") ?? "img";
    const file = `image-${sanitize(model)}.${ext}`;
    writeFileSync(path.join(outDir, file), image.bytes);
    // usage.model is "<provider>/<full model id>" and the model id itself may
    // contain slashes (e.g. "nvidia/black-forest-labs/flux.2-klein-4b"), so
    // split only at the FIRST slash.
    const slash = out.usage.model.indexOf("/");
    const routedProvider = slash >= 0 ? out.usage.model.slice(0, slash) : "freellmapi";
    const routedModel = slash >= 0 ? out.usage.model.slice(slash + 1) : out.usage.model;
    const quality: Quality = image.bytes.byteLength > 4096 && Boolean(dims) && dims!.width >= 512 && dims!.height >= 288 ? "PASS" : "FAIL";
    return {
      ...base, status: "success", http_status: 200, latency_ms: Date.now() - started,
      content_type: image.media_type, bytes: image.bytes.byteLength,
      width: dims?.width ?? null, height: dims?.height ?? null,
      routed_provider: routedProvider ?? "freellmapi", routed_model: routedModel ?? model,
      availability: "AVAILABLE", cost: out.usage.cost_usd > 0 ? "PAID_ONLY" : "FREE", quality,
      promotable: quality === "PASS", artifact: file,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const { availability, cost } = classifyFailure(err, reason);
    return { ...base, latency_ms: Date.now() - started, failure_reason: reason, availability, cost };
  }
}

async function bakeVideo(model: string, outDir: string): Promise<Attempt> {
  const started = Date.now();
  const base: Attempt = {
    modality: "video", requested_model: model, routed_provider: null, routed_model: null,
    status: "failed", http_status: null, latency_ms: 0, content_type: null, bytes: 0,
    width: null, height: null, duration_sec: null, codec: null, failure_reason: null,
    availability: "BROKEN", cost: "UNKNOWN", quality: "UNKNOWN", promotable: false, artifact: null,
  };
  try {
    const provider = new FreeLlmVideoProvider({ models: [model] });
    const out = await provider.generate(VIDEO_PROMPT);
    const attempt = provider.lastAttempts[0];
    if (!out) {
      const reason = attempt?.failure_reason ?? "no video produced";
      const { availability, cost } = attempt?.not_free
        ? { availability: "AVAILABLE" as Availability, cost: "PAID_ONLY" as Cost }
        : classifyFailure(reason, reason);
      return {
        ...base, latency_ms: Date.now() - started,
        http_status: attempt?.http_status ?? null, failure_reason: reason, availability, cost,
      };
    }
    const file = `video-${sanitize(model)}.mp4`;
    writeFileSync(path.join(outDir, file), out.bytes);
    return {
      ...base, status: "success", http_status: 200, latency_ms: Date.now() - started,
      content_type: out.media_type, bytes: out.bytes.byteLength,
      duration_sec: out.duration_sec ?? null,
      routed_provider: out.upstream_provider, routed_model: out.routed_model,
      availability: "AVAILABLE", cost: "FREE",
      // quality stays UNKNOWN here — the workflow's ffprobe GATE decides
      // PASS/FAIL (real video stream, supported codec, non-zero duration, sane
      // dimensions) and rewrites this field before promotion.
      quality: "UNKNOWN", promotable: false, artifact: file,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const { availability, cost } = classifyFailure(err, reason);
    return { ...base, latency_ms: Date.now() - started, failure_reason: reason, availability, cost };
  }
}

async function main(): Promise<void> {
  const outDir = path.resolve(arg("out") ?? "./media-bakeoff");
  mkdirSync(outDir, { recursive: true });
  const imageModels = assertConcreteMediaModels(arg("image") ?? process.env["FREELLMAPI_IMAGE_MODELS"], "FREELLMAPI_IMAGE_MODELS");
  const videoModels = assertConcreteMediaModels(arg("video") ?? process.env["FREELLMAPI_VIDEO_MODELS"], "FREELLMAPI_VIDEO_MODELS");

  console.log(`[free-media-smoke] image models: ${imageModels.join(", ") || "(none)"}`);
  console.log(`[free-media-smoke] video models: ${videoModels.join(", ") || "(none)"}`);

  const attempts: Attempt[] = [];
  for (const model of imageModels) {
    console.log(`[free-media-smoke] image <- ${model}`);
    attempts.push(await bakeImage(model, outDir));
  }
  for (const model of videoModels) {
    console.log(`[free-media-smoke] video <- ${model}`);
    attempts.push(await bakeVideo(model, outDir));
  }

  const report = {
    generated_at: new Date().toISOString(),
    image_prompt: IMAGE_PROMPT,
    video_prompt: VIDEO_PROMPT,
    paid_video_fallback: process.env["PAID_VIDEO_FALLBACK"],
    attempts,
    summary: {
      promotable_images: attempts.filter((a) => a.modality === "image" && a.promotable).map((a) => a.requested_model),
      video_needs_ffprobe_gate: attempts.filter((a) => a.modality === "video" && a.status === "success").map((a) => a.requested_model),
      quota_exhausted: attempts.filter((a) => a.availability === "QUOTA_EXHAUSTED").map((a) => a.requested_model),
      auth_error: attempts.filter((a) => a.availability === "AUTH_ERROR").map((a) => a.requested_model),
      paid_only: attempts.filter((a) => a.cost === "PAID_ONLY").map((a) => a.requested_model),
      broken: attempts.filter((a) => a.availability === "BROKEN").map((a) => a.requested_model),
    },
  };
  writeFileSync(path.join(outDir, "media-bakeoff-report.json"), JSON.stringify(report, null, 2));
  const lines = attempts.map((a) =>
    `${a.modality}\t${a.requested_model}\t${a.availability}\t${a.cost}\t${a.quality}\tpromotable=${a.promotable}\t${a.bytes}B\t${a.width ?? "?"}x${a.height ?? "?"}\t${a.failure_reason ?? ""}`);
  writeFileSync(path.join(outDir, "media-bakeoff-summary.txt"),
    `modality\tmodel\tavailability\tcost\tquality\tpromotable\tbytes\tdims\treason\n${lines.join("\n")}\n`);
  console.log(`[free-media-smoke] wrote ${attempts.length} attempt(s) to ${outDir}`);
  for (const a of attempts) console.log(`  ${a.modality} ${a.requested_model}: availability=${a.availability} cost=${a.cost} quality=${a.quality} promotable=${a.promotable}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
