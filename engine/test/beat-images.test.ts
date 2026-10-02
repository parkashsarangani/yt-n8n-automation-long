/**
 * Per-beat editor images (2026-09-30): one gpt-image-1-mini medium portrait
 * per beat into <episode>/beats/, capped, resumable without paying twice,
 * and never mistaken for an editor upload.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PromptStore } from "../src/prompts.ts";
import { FakeDriveProvider } from "../src/providers/fake.ts";
import { isPipelineAuthoredFile } from "../src/workers/editor-package.ts";
import {
  BEAT_FRAME, BEAT_IMAGE_MODEL, MAX_BEAT_IMAGES, STYLE, shortFrameArgs, deliverBeatImages, generateBeatImage, planBeats, selectBeats, type BeatScene,
} from "../src/beat-images.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENES: BeatScene[] = [
  { scene_index: 0, narration: "It's 11 p.m. You're replaying something you said at lunch.", point: "The replay" },
  { scene_index: 1, narration: "Your brain treats the moment like an unfinished task.", point: "Unfinished loops" },
  { scene_index: 2, narration: "Write down one sentence about it, then close the notebook.", point: "Close the loop" },
  { scene_index: 3, narration: "Follow Quiet Signal for more psychology and philosophy.", is_outro: true },
];

function fakeModel(value: unknown) {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      id: "fake/model",
      capabilities: () => ({ structuredOutput: "native" as const, maxOutputTokens: 8000 }),
      complete: async (req: { prompt: string }) => {
        prompts.push(req.prompt);
        if (value instanceof Error) throw value;
        return { value, usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "fake", model: "fake" }, providerRef: "fake/model" };
      },
    },
  };
}

test("the closing follow line gets no image, and a long script is capped", () => {
  assert.deepEqual(selectBeats(SCENES).map((s) => s.scene_index), [0, 1, 2]);
  const many = Array.from({ length: 12 }, (_, i) => ({ scene_index: i, narration: `beat ${i}` }));
  assert.equal(selectBeats(many).length, MAX_BEAT_IMAGES);
});

test("the fast model describes each beat; a missing description falls back to the beat's own words", async () => {
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const m = fakeModel({ images: [
    { scene_index: 0, description: "A person sits alone at a kitchen table at night, lit by one lamp." },
    { scene_index: 1, description: "short" },
  ] });
  const plans = await planBeats("Why You Replay Awkward Moments", SCENES, { provider: m.provider as never, prompts });
  assert.match(m.prompts[0]!, /1: Your brain treats the moment/);
  assert.doesNotMatch(m.prompts[0]!, /Follow Quiet Signal/, "the outro is not planned");
  assert.deepEqual(plans.map((p) => p.file), ["01-hook.png", "02-unfinished-loops.png", "03-close-the-loop.png"]);
  assert.match(plans[0]!.description, /kitchen table/);
  assert.match(plans[1]!.description, /Unfinished loops/, "too-short description replaced by the beat's own words");
});

test("images and prompts.md land in beats/; a second pass pays for nothing already there", async () => {
  const drive = new FakeDriveProvider();
  const episode = await drive.createFolder("2026-09-30-abc", "root");
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const plans = await planBeats("T", SCENES, { provider: null, prompts });
  const calls: string[] = [];
  const generate = async (p: string) => { calls.push(p); return new Uint8Array([1, 2, 3]); };

  const first = await deliverBeatImages({ episodeFolderId: episode, title: "T", plans }, { drive, generate });
  assert.equal(first.generated, 3);
  assert.ok(calls.every((p) => p.startsWith(STYLE)), "the fixed style leads every prompt");
  const [beats] = (await drive.listFiles(episode)).filter((f) => f.name === "beats");
  assert.ok(beats, "beats/ subfolder created");
  const names = (await drive.listFiles(beats!.id)).map((f) => f.name).sort();
  assert.deepEqual(names, ["01-hook.png", "02-unfinished-loops.png", "03-close-the-loop.png", "prompts.md"]);

  const second = await deliverBeatImages({ episodeFolderId: episode, title: "T", plans }, { drive, generate });
  assert.equal(second.generated, 0);
  assert.equal(second.skipped_existing, 3);
  assert.equal(calls.length, 3, "no second payment");
  assert.equal((await drive.listFiles(episode)).filter((f) => f.name === "beats").length, 1, "one beats folder");
});

test("an empty balance stops at the first failure and the pass reports failure", async () => {
  const drive = new FakeDriveProvider();
  const episode = await drive.createFolder("ep", "root");
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const plans = await planBeats("T", SCENES, { provider: null, prompts });
  let calls = 0;
  const generate = async () => { calls++; throw new Error("image generation failed (429 insufficient_quota): out of funds"); };
  await assert.rejects(deliverBeatImages({ episodeFolderId: episode, title: "T", plans }, { drive, generate }), /no beat image/);
  assert.equal(calls, 1);
});

test("a broken crop stops at the first beat instead of paying for images that would be thrown away", async () => {
  const drive = new FakeDriveProvider();
  const episode = await drive.createFolder("ep", "root");
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const plans = await planBeats("T", SCENES, { provider: null, prompts });
  let calls = 0;
  const generate = async () => { calls++; throw new Error("frame crop failed: spawn ffmpeg ENOENT"); };
  await assert.rejects(deliverBeatImages({ episodeFolderId: episode, title: "T", plans }, { drive, generate }), /frame crop failed/);
  assert.equal(calls, 1);
});

test("one failed beat does not stop the rest, and prompts.md names it", async () => {
  const drive = new FakeDriveProvider();
  const episode = await drive.createFolder("ep", "root");
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const plans = await planBeats("T", SCENES, { provider: null, prompts });
  let n = 0;
  const generate = async () => { if (++n === 2) throw new Error("image generation failed (400 moderation_blocked): no"); return new Uint8Array([1]); };
  const r = await deliverBeatImages({ episodeFolderId: episode, title: "T", plans }, { drive, generate });
  assert.equal(r.generated, 2);
  assert.deepEqual(r.failed, ["02-unfinished-loops.png"]);
  const beats = (await drive.listFiles(episode)).find((f) => f.name === "beats")!;
  const md = (await drive.listFiles(beats.id)).find((f) => f.name === "prompts.md")!;
  assert.match(new TextDecoder().decode(await drive.downloadFile(md.id)), /Not generated this time: 02-unfinished-loops\.png/);
});

test("the Images API request: mini, portrait, medium; the key never leaks into an error", async () => {
  let sent: Record<string, unknown> = {};
  let auth = "";
  const ok = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    auth = (init.headers as Record<string, string>)["Authorization"]!;
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const bytes = await generateBeatImage("a prompt", { apiKey: "sk-test", fetchImpl: ok });
  assert.equal(new TextDecoder().decode(bytes), "png");
  assert.deepEqual({ model: sent.model, size: sent.size, quality: sent.quality, n: sent.n }, { model: BEAT_IMAGE_MODEL, size: "1024x1536", quality: "medium", n: 1 });
  assert.equal(auth, "Bearer sk-test");

  const bad = (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key sk-test", code: "invalid_api_key" } }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(generateBeatImage("p", { apiKey: "sk-test", fetchImpl: bad }), (e: Error) => /\(401 invalid_api_key\)/.test(e.message) && !e.message.includes("sk-test"));
});

test("the style is stickman with expressive faces, and never asks for text", async () => {
  assert.match(STYLE, /stick ?(man|figures)/i);
  assert.match(STYLE, /facial|expressive face/i);
  assert.match(STYLE, /no text/i);
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const [plan] = await planBeats("T", SCENES, { provider: null, prompts });
  assert.match(plan!.description, /stick figure.*facial expression/i, "the fallback keeps the style too");
});

test("images are delivered at the Short's exact 1080x1920 frame (operator: 'wrong size')", () => {
  const args = shortFrameArgs("in.png", "out.png");
  const vf = args[args.indexOf("-vf") + 1]!;
  // 1024x1536 scaled to height 1920 is 1280 wide; the centre 1080 is kept.
  assert.equal(vf, "scale=-2:1920:flags=lanczos,crop=1080:1920");
  assert.deepEqual(BEAT_FRAME, { width: 1080, height: 1920 });
  assert.match(STYLE, /away from the left and right edges/, "figures stay inside the crop");
});

test("our beats/ folder is never reported as an unrecognised editor upload", () => {
  assert.equal(isPipelineAuthoredFile("beats"), true);
});
