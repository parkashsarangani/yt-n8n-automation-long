import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CachedImageProvider, type ImageBankEntry } from "../src/providers/cached-image.ts";
import type { Aspect, Usage } from "../src/provider.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR len+type
  0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x04, 0x00, // width 1792, height 1024
  0x08, 0x02, 0x00, 0x00, 0x00,
]);

function falUsage(units: number): Usage {
  return { input_tokens: 0, output_tokens: 0, units, cost_usd: units * 0.025, provider: "fal", model: "fal-ai/flux-2" };
}

class FakeFal {
  readonly id = "fal/fal-ai/flux-2";
  generateCalls = 0;
  packCalls = 0;
  async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    this.generateCalls += 1;
    const n = req.count ?? 1;
    return { images: Array.from({ length: n }, () => ({ bytes: PNG, media_type: "image/png" })), usage: falUsage(n) };
  }
  async generatePack(req: { prompts: string[]; aspect: Aspect; seed: number }) {
    this.packCalls += 1;
    return { images: req.prompts.map(() => ({ bytes: PNG, media_type: "image/png" })), usage: falUsage(req.prompts.length) };
  }
}

const silent = { log: () => {}, warn: () => {} };
function bank() {
  const dir = mkdtempSync(path.join(tmpdir(), "imgbank-"));
  const fal = new FakeFal();
  return { dir, fal, provider: new CachedImageProvider(fal as never, dir, silent) };
}

test("a second identical generate is served from the bank with zero cost and no provider call", async () => {
  const { fal, provider } = bank();
  const a = await provider.generate({ prompt: "a courier on horseback at dawn", aspect: "16:9" });
  assert.equal(fal.generateCalls, 1);
  assert.equal(a.usage.cost_usd, 0.025);

  const b = await provider.generate({ prompt: "a courier on horseback at dawn", aspect: "16:9" });
  assert.equal(fal.generateCalls, 1, "no second provider call");
  assert.equal(b.usage.cost_usd, 0);
  assert.deepEqual(b.images[0]!.bytes, a.images[0]!.bytes);
  assert.deepEqual(provider.stats(), { hits: 1, misses: 1 });
});

test("any changed input (prompt, aspect, tier) is a fresh generation", async () => {
  const { fal, provider } = bank();
  await provider.generate({ prompt: "p1", aspect: "16:9" });
  await provider.generate({ prompt: "p2", aspect: "16:9" });
  await provider.generate({ prompt: "p1", aspect: "9:16" });
  await provider.generate({ prompt: "p1", aspect: "16:9", tier: "hero" });
  assert.equal(fal.generateCalls, 4);
});

test("the metadata sidecar records the full prompt and provenance", async () => {
  const { dir, provider } = bank();
  await provider.generate({ prompt: "the exact full prompt text, never truncated, with numbers 1000000", aspect: "16:9", tier: "hero" });
  const meta = readdirSync(dir).find((f) => f.endsWith(".json"))!;
  const entry = JSON.parse(readFileSync(path.join(dir, meta), "utf8")) as ImageBankEntry;
  assert.equal(entry.op, "generate");
  assert.equal(entry.prompt, "the exact full prompt text, never truncated, with numbers 1000000");
  assert.equal(entry.aspect, "16:9");
  assert.equal(entry.tier, "hero");
  assert.equal(entry.provider, "fal/fal-ai/flux-2");
  assert.equal(entry.media_type, "image/png");
  assert.equal(entry.width, 1792);
  assert.equal(entry.height, 1024);
  assert.equal(entry.bytes, PNG.byteLength);
  assert.match(entry.content_sha256, /^[0-9a-f]{64}$/);
  assert.match(entry.created_at, /^\d{4}-\d\d-\d\dT/);
});

test("a reference-conditioned pack keys on prompt + seed + reference bytes", async () => {
  const { fal, provider } = bank();
  const ref = { bytes: new Uint8Array([9, 9, 9]), media_type: "image/png" };
  await provider.generatePack({ prompts: ["shot a", "shot b"], aspect: "16:9", seed: 42, reference: ref });
  assert.equal(fal.packCalls, 1);
  // same inputs -> full hit, no provider call
  const again = await provider.generatePack({ prompts: ["shot a", "shot b"], aspect: "16:9", seed: 42, reference: ref });
  assert.equal(fal.packCalls, 1);
  assert.equal(again.usage.cost_usd, 0);
  // different reference bytes -> miss
  await provider.generatePack({ prompts: ["shot a", "shot b"], aspect: "16:9", seed: 42, reference: { bytes: new Uint8Array([1]), media_type: "image/png" } });
  assert.equal(fal.packCalls, 2);
});

// A toy embedder: each text maps to a vector of per-keyword counts over a
// fixed vocab, so paraphrases with shared concepts land close in cosine space.
const VOCAB = ["courier", "horse", "horseback", "rider", "message", "note", "letter", "sealed", "road", "ancient", "antiquity", "chart", "revenue", "lake", "forest", "sunset"];
const SYN: Record<string, string> = { horseback: "horse", rider: "courier", letter: "note", antiquity: "ancient" };
const toyEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    const words = t.toLowerCase().split(/\W+/).map((w) => SYN[w] ?? w);
    return VOCAB.map((v) => words.filter((w) => w === v).length);
  });

test("searchByContext (embeddings) matches a paraphrase from a different prompt", async () => {
  const { dir, fal } = bank();
  const p = new CachedImageProvider(fal as never, dir, silent, { embed: toyEmbed });
  await p.generate({
    prompt: "Realistic wide shot of a mounted courier carrying a sealed message along an ancient road",
    aspect: "16:9",
    context: { mode: "generated_image", requirement: "courier holding sealed note; horse in motion; ancient road", narration: "the message might travel with a mounted courier" },
  });
  assert.equal(fal.generateCalls, 1);

  const q = new CachedImageProvider(fal as never, dir, silent, { embed: toyEmbed });
  const hits = await q.searchByContext({
    requirement: "a rider on horseback transporting a sealed letter down a road in antiquity",
    narration: "couriers once carried sealed notes on horseback",
    mode: "generated_image",
  }, 4);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]!.bytes, PNG);
});

test("searchByContext ignores images from a different mode and unrelated beats", async () => {
  const { dir, fal } = bank();
  const p = new CachedImageProvider(fal as never, dir, silent, { embed: toyEmbed });
  await p.generate({ prompt: "a bar chart of quarterly revenue", aspect: "16:9", context: { mode: "motion_graphic", requirement: "revenue bars growing quarter by quarter" } });
  await p.generate({ prompt: "a calm forest lake at sunset", aspect: "16:9", context: { mode: "generated_image", requirement: "still water, forest, sunset" } });
  const hits = await p.searchByContext({ requirement: "a mounted courier carrying a sealed message on an ancient road", mode: "generated_image" }, 4);
  assert.equal(hits.length, 0);
});

test("searchByContext falls back to keyword overlap when no embedder is configured", async () => {
  const { dir, fal } = bank();
  const p = new CachedImageProvider(fal as never, dir, silent);
  await p.generate({ prompt: "mounted courier carrying a sealed message along an ancient road", aspect: "16:9", context: { mode: "generated_image", requirement: "mounted courier carrying a sealed message along an ancient road" } });
  const hits = await p.searchByContext({ requirement: "mounted courier carrying a sealed message along an ancient road" }, 4);
  assert.equal(hits.length, 1);
});

test("the bank survives a new provider instance over the same directory", async () => {
  const { dir, fal } = bank();
  const p1 = new CachedImageProvider(fal as never, dir, silent);
  await p1.generate({ prompt: "persisted", aspect: "16:9" });
  assert.equal(fal.generateCalls, 1);
  const p2 = new CachedImageProvider(fal as never, dir, silent);
  const hit = await p2.generate({ prompt: "persisted", aspect: "16:9" });
  assert.equal(fal.generateCalls, 1, "second instance reused the on-disk entry");
  assert.equal(hit.usage.cost_usd, 0);
});
