/**
 * Shorts phase 2 (2026-09-29): Facebook/Instagram Reels cross-posting.
 * The Meta clients are exercised against a scripted fake Graph API; the
 * cross-post logic against fake targets and an in-memory run log.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FacebookReelsTarget, InstagramReelsTarget, type ReelsTarget } from "../src/providers/meta-reels.ts";
import { crosspostRun, crosspostSettled, reelCaption, CROSSPOST_MAX_ATTEMPTS, REEL_CAPTION_MAX } from "../src/crosspost.ts";
import type { RunRecord } from "../src/runlog.ts";

const TOKEN = "EAAtest-secret-token";
const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

function fakeGraph(respond: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const body = init.body instanceof URLSearchParams ? init.body.toString() : init.body instanceof Uint8Array ? `<${init.body.byteLength} bytes>` : String(init.body ?? "");
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body });
    const out = respond(url, init);
    return new Response(JSON.stringify(out), { status: (out as { error?: unknown })?.error ? 400 : 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const noSleep = async () => {};

test("Facebook Reel: start, upload bytes, finish PUBLISHED, wait for publishing; token never in a URL", async () => {
  let polls = 0;
  const g = fakeGraph((url, init) => {
    if (url.includes("/video_reels") && String(init.body).includes("upload_phase=start")) return { video_id: "v123", upload_url: "https://rupload.facebook.com/video-upload/v25.0/v123" };
    if (url.startsWith("https://rupload.facebook.com")) return { success: true };
    if (url.includes("/video_reels")) return { success: true };
    if (url.includes("/v123?")) return { status: { video_status: ++polls < 2 ? "processing" : "ready" } };
    throw new Error(`unexpected ${url}`);
  });
  const fb = new FacebookReelsTarget("page1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  const r = await fb.post({ video: VIDEO, media_type: "video/mp4", caption: "Caption #psychology", title: "A title" });
  assert.deepEqual(r, { external_id: "v123", url: "https://www.facebook.com/reel/v123" });
  const upload = g.calls.find((c) => c.url.startsWith("https://rupload"))!;
  assert.equal(upload.headers["file_size"], String(VIDEO.byteLength));
  assert.equal(upload.headers["offset"], "0");
  assert.equal(upload.headers["Authorization"], `OAuth ${TOKEN}`);
  const finish = g.calls.find((c) => c.body.includes("upload_phase=finish"))!;
  assert.match(finish.body, /video_state=PUBLISHED/);
  assert.match(finish.body, /description=Caption/);
  assert.ok(g.calls.every((c) => !c.url.includes(TOKEN)), "the token must never appear in a URL");
});

test("Facebook: a Graph error surfaces with the token redacted", async () => {
  const g = fakeGraph(() => ({ error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } }));
  const fb = new FacebookReelsTarget("page1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  await assert.rejects(fb.post({ video: VIDEO, media_type: "video/mp4", caption: "c", title: "t" }), (e: Error) => {
    assert.match(e.message, /code 190/);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

test("Instagram Reel: container from a public video_url, wait for FINISHED, publish, permalink -- no byte upload", async () => {
  let polls = 0;
  const g = fakeGraph((url) => {
    if (url.endsWith("/ig1/media")) return { id: "c9" };
    if (url.includes("/c9?")) return { status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" };
    if (url.endsWith("/ig1/media_publish")) return { id: "m77" };
    if (url.includes("/m77?")) return { permalink: "https://www.instagram.com/reel/ABC/" };
    throw new Error(`unexpected ${url}`);
  });
  const ig = new InstagramReelsTarget("ig1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  assert.equal(ig.needsVideoUrl, true);
  await assert.rejects(ig.post({ video: VIDEO, media_type: "video/mp4", caption: "c", title: "t" }), /needs a public video_url/);
  const r = await ig.post({ video: VIDEO, media_type: "video/mp4", caption: "Caption", title: "t", video_url: "https://drive.usercontent.google.com/download?id=F1" });
  assert.deepEqual(r, { external_id: "m77", url: "https://www.instagram.com/reel/ABC/" });
  const create = g.calls.find((c) => c.url.endsWith("/ig1/media"))!;
  assert.match(create.body, /media_type=REELS/);
  assert.match(create.body, /video_url=https%3A%2F%2Fdrive\.usercontent\.google\.com/);
  assert.doesNotMatch(create.body, /upload_type/);
  assert.ok(!g.calls.some((c) => c.url.startsWith("https://rupload")), "no byte upload (rupload fails in production)");
  assert.match(g.calls.find((c) => c.url.endsWith("/media_publish"))!.body, /creation_id=c9/);
  assert.ok(g.calls.every((c) => !c.url.includes(TOKEN)));
});

test("Instagram: a container that errors is reported with Instagram's reason, never published", async () => {
  const g = fakeGraph((url) => url.endsWith("/ig1/media") ? { id: "c9" } : { status_code: "ERROR", status: "Error: media download failed" });
  const ig = new InstagramReelsTarget("ig1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  await assert.rejects(ig.post({ video: VIDEO, media_type: "video/mp4", caption: "c", title: "t", video_url: "https://x/v.mp4" }), /status ERROR: Error: media download failed/);
  assert.ok(!g.calls.some((c) => c.url.endsWith("/media_publish")));
});

// -- cross-post logic ---------------------------------------------------------

function harness(targets: ReelsTarget[], existing: RunRecord[] = []) {
  const log: RunRecord[] = [...existing];
  const alerts: string[] = [];
  const deps = {
    targets,
    records: async (id: string) => log.filter((r) => r.run_id === id),
    record: async (r: RunRecord) => { log.push(r); },
    alert: async (_run: string, reason: string) => { alerts.push(reason); },
  };
  const candidate = { run_id: "run_a", video: async () => VIDEO, media_type: "video/mp4", seo: { title: "Why You Replay Awkward Moments", description: "An everyday-psychology Short.", tags: ["psychology", "self improvement"] } };
  return { log, alerts, deps, candidate };
}
const target = (id: "facebook" | "instagram", post: () => Promise<{ external_id: string; url: string }>) => ({ id, post } as ReelsTarget);

test("each platform is posted once, independently: a failure on one does not touch the other", async () => {
  let fbCalls = 0;
  const fb = target("facebook", async () => { fbCalls++; return { external_id: "v1", url: "https://www.facebook.com/reel/v1" }; });
  const ig = target("instagram", async () => { throw new Error("IG is down"); });
  const h = harness([fb, ig]);
  assert.deepEqual(await crosspostRun(h.candidate, h.deps), { facebook: "posted", instagram: "failed" });
  // The next pass retries Instagram only; Facebook is done and is not re-posted.
  assert.deepEqual(await crosspostRun(h.candidate, h.deps), { facebook: "done", instagram: "failed" });
  assert.equal(fbCalls, 1);
  const ok = h.log.find((r) => r.node_id === "crosspost_facebook" && r.status === "ok")!;
  assert.equal(ok.output, "https://www.facebook.com/reel/v1");
  assert.equal(ok.graph_id, null, "a tag record, invisible to run reconstruction");
});

test("a crash mid-upload (last record 'running') is never re-posted automatically", async () => {
  let calls = 0;
  const fb = target("facebook", async () => { calls++; return { external_id: "v", url: "u" }; });
  const h = harness([fb], [{ run_id: "run_a", graph_id: null, node_id: "crosspost_facebook", transformation: "facebook", transformation_version: "1", inputs: [], output: null, status: "running", attempt: 1, max_attempts: 3, started_at: "2026-09-29T00:00:00Z", duration_ms: 0 }]);
  assert.deepEqual(await crosspostRun(h.candidate, h.deps), { facebook: "uncertain" });
  assert.equal(calls, 0);
});

test(`after ${CROSSPOST_MAX_ATTEMPTS} failures a human is alerted once, then it stops trying`, async () => {
  const ig = target("instagram", async () => { throw new Error("token expired"); });
  const h = harness([ig]);
  for (let i = 0; i < CROSSPOST_MAX_ATTEMPTS; i++) await crosspostRun(h.candidate, h.deps);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0]!, /instagram after 3 attempts/);
  assert.deepEqual(await crosspostRun(h.candidate, h.deps), { instagram: "gave_up" });
  assert.equal(h.alerts.length, 1, "no repeat alerts");
});

test("the fallback Reel caption is the title and up to five hashtags -- never the long description", () => {
  const c = reelCaption({ title: "T", description: "D", tags: ["self improvement", "psychology", "a", "habits", "mind", "focus", "extra"] });
  assert.equal(c, "T\n\n#selfimprovement #psychology #habits #mind #focus");
  assert.ok(reelCaption({ title: "x".repeat(5000), description: "D" }).length <= REEL_CAPTION_MAX);
});

const capturing = (id: "facebook" | "instagram", seen: Record<string, string>) =>
  ({ id, post: async (p: { caption: string }) => { seen[id] = p.caption; return { external_id: id, url: id }; } }) as unknown as ReelsTarget;

test("Instagram gets a temporary public copy; Facebook gets the bytes; the copy is always released", async () => {
  const seen: Record<string, string | undefined> = {};
  const fb = { id: "facebook", post: async (p: { video_url?: string }) => { seen.facebook = p.video_url; return { external_id: "v1", url: "v1" }; } } as unknown as ReelsTarget;
  let igFails = true;
  const ig = { id: "instagram", needsVideoUrl: true, post: async (p: { video_url?: string }) => {
    seen.instagram = p.video_url;
    if (igFails) throw new Error("Instagram could not process the Reel (status ERROR)");
    return { external_id: "m", url: "m" };
  } } as unknown as ReelsTarget;
  const h = harness([fb, ig]);
  let published = 0, released = 0;
  const deps = { ...h.deps, publicVideo: async (v: Uint8Array) => { assert.equal(v, VIDEO); published++; return { url: `https://drive/copy${published}`, release: async () => { released++; } }; } };
  assert.deepEqual(await crosspostRun(h.candidate, deps), { facebook: "posted", instagram: "failed" });
  assert.equal(seen.facebook, undefined, "Facebook takes the bytes");
  assert.equal(seen.instagram, "https://drive/copy1");
  assert.equal(released, 1, "released even though the post failed");
  igFails = false;
  assert.deepEqual(await crosspostRun(h.candidate, deps), { facebook: "done", instagram: "posted" });
  assert.equal(published, 2);
  assert.equal(released, 2);
  assert.equal(crosspostSettled(h.log, ig), true);
});

test("without a public video host, Instagram fails loudly instead of silently never posting", async () => {
  const ig = { id: "instagram", needsVideoUrl: true, post: async () => ({ external_id: "m", url: "m" }) } as unknown as ReelsTarget;
  const h = harness([ig]);
  for (let i = 0; i < CROSSPOST_MAX_ATTEMPTS; i++) await crosspostRun(h.candidate, h.deps);
  assert.equal(h.alerts.length, 1);
  assert.match(h.log.find((r) => r.status === "failed")!.error!, /no public video host/);
});

test("each platform gets its own caption, generated once per pass", async () => {
  const seen: Record<string, string> = {};
  const h = harness([capturing("facebook", seen), capturing("instagram", seen)]);
  let generated = 0;
  const captions = async () => { generated++; return { facebook: "You do this every day.\n\n#psychology #mind", instagram: "Why your brain replays it" }; };
  await crosspostRun({ ...h.candidate, captions }, h.deps);
  assert.equal(generated, 1);
  assert.equal(seen.facebook, "You do this every day.\n\n#psychology #mind");
  assert.equal(seen.instagram, "Why your brain replays it");
});

test("a caption generator failure falls back to the short title caption and still posts", async () => {
  const seen: Record<string, string> = {};
  const h = harness([capturing("facebook", seen)]);
  const out = await crosspostRun({ ...h.candidate, captions: async () => { throw new Error("model down"); } }, h.deps);
  assert.deepEqual(out, { facebook: "posted" });
  assert.equal(seen.facebook, "Why You Replay Awkward Moments\n\n#psychology #selfimprovement");
});
