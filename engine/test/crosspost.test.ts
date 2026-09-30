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

test("Instagram Reel: resumable container, upload, wait for FINISHED, publish, permalink", async () => {
  let polls = 0;
  const g = fakeGraph((url) => {
    if (url.endsWith("/ig1/media")) return { id: "c9", uri: "https://rupload.facebook.com/ig-api-upload/v25.0/c9" };
    if (url.startsWith("https://rupload.facebook.com")) return { success: true };
    if (url.includes("/c9?")) return { status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" };
    if (url.endsWith("/ig1/media_publish")) return { id: "m77" };
    if (url.includes("/m77?")) return { permalink: "https://www.instagram.com/reel/ABC/" };
    throw new Error(`unexpected ${url}`);
  });
  const ig = new InstagramReelsTarget("ig1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  const r = await ig.post({ video: VIDEO, media_type: "video/mp4", caption: "Caption", title: "t" });
  assert.deepEqual(r, { external_id: "m77", url: "https://www.instagram.com/reel/ABC/" });
  const create = g.calls.find((c) => c.url.endsWith("/ig1/media"))!;
  assert.match(create.body, /media_type=REELS/);
  assert.match(create.body, /upload_type=resumable/);
  assert.match(g.calls.find((c) => c.url.endsWith("/media_publish"))!.body, /creation_id=c9/);
});

test("Instagram-login token: the container takes a public video_url, nothing is uploaded (prod: 'video_url is required')", async () => {
  const g = fakeGraph((url) => {
    if (url.endsWith("/me/media")) return { id: "c9" };
    if (url.includes("/c9?")) return { status_code: "FINISHED" };
    if (url.endsWith("/me/media_publish")) return { id: "m77" };
    if (url.includes("/m77?")) return { permalink: "https://www.instagram.com/reel/ABC/" };
    throw new Error(`unexpected ${url}`);
  });
  const ig = new InstagramReelsTarget("me", { accessToken: TOKEN, graphBase: "https://graph.instagram.com", fetchImpl: g.fetchImpl, sleep: noSleep });
  assert.equal(ig.needsVideoUrl, true);
  await assert.rejects(ig.post({ video: VIDEO, media_type: "video/mp4", caption: "c", title: "t" }), /needs a public video_url/);
  const r = await ig.post({ video: VIDEO, media_type: "video/mp4", caption: "Caption", title: "t", video_url: "https://video.xx.fbcdn.net/v/reel.mp4?sig=1" });
  assert.equal(r.external_id, "m77");
  const create = g.calls.find((c) => c.url.endsWith("/me/media"))!;
  assert.match(create.body, /video_url=https%3A%2F%2Fvideo\.xx\.fbcdn\.net/);
  assert.doesNotMatch(create.body, /upload_type/);
  assert.ok(!g.calls.some((c) => c.url.startsWith("https://rupload")), "no byte upload");
  assert.equal(new InstagramReelsTarget("ig1", { accessToken: TOKEN }).needsVideoUrl, false, "Page-token route keeps resumable upload");
});

test("Facebook: a published Reel's public source URL", async () => {
  const g = fakeGraph((url) => url.includes("/v123?") ? { source: "https://video.xx.fbcdn.net/v/reel.mp4?sig=1" } : { error: { message: "x" } });
  const fb = new FacebookReelsTarget("page1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  assert.equal(await fb.sourceUrl("v123"), "https://video.xx.fbcdn.net/v/reel.mp4?sig=1");
  assert.match(g.calls[0]!.url, /fields=source/);
});

test("Instagram: a container that errors is reported, never published", async () => {
  const g = fakeGraph((url) => url.endsWith("/ig1/media") ? { id: "c9" } : url.startsWith("https://rupload") ? { success: true } : { status_code: "ERROR" });
  const ig = new InstagramReelsTarget("ig1", { accessToken: TOKEN, fetchImpl: g.fetchImpl, sleep: noSleep });
  await assert.rejects(ig.post({ video: VIDEO, media_type: "video/mp4", caption: "c", title: "t" }), /status ERROR/);
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

test("Instagram-login posts after Facebook, from the Facebook Reel's public URL, in the same pass", async () => {
  const urls: Array<string | undefined> = [];
  const fb = target("facebook", async () => ({ external_id: "v1", url: "https://www.facebook.com/reel/v1" }));
  const ig = { id: "instagram", needsVideoUrl: true, post: async (p: { video_url?: string }) => { urls.push(p.video_url); return { external_id: "m", url: "m" }; } } as unknown as ReelsTarget;
  const h = harness([fb, ig]);
  const out = await crosspostRun(h.candidate, {
    ...h.deps,
    videoUrl: async (records) => records.find((r) => r.node_id === "crosspost_facebook" && r.status === "ok")?.model === "v1" ? "https://cdn/v1.mp4" : undefined,
  });
  assert.deepEqual(out, { facebook: "posted", instagram: "posted" });
  assert.deepEqual(urls, ["https://cdn/v1.mp4"]);
});

test("without a public URL yet, Instagram waits -- no attempt recorded, no alert; it gives up only when Facebook did", async () => {
  const igPost = async () => { throw new Error("must not post"); };
  const ig = { id: "instagram", needsVideoUrl: true, post: igPost } as unknown as ReelsTarget;
  const fbDown = target("facebook", async () => { throw new Error("FB down"); });
  const h = harness([fbDown, ig]);
  const deps = { ...h.deps, videoUrl: async () => undefined };
  assert.deepEqual(await crosspostRun(h.candidate, deps), { facebook: "failed", instagram: "waiting" });
  assert.equal(h.log.filter((r) => r.node_id === "crosspost_instagram").length, 0, "waiting is not an attempt");
  for (let i = 1; i < CROSSPOST_MAX_ATTEMPTS; i++) await crosspostRun(h.candidate, deps);
  assert.deepEqual(await crosspostRun(h.candidate, deps), { facebook: "gave_up", instagram: "gave_up" });
  assert.equal(h.alerts.length, 1, "only Facebook's own give-up alerts");
  assert.equal(crosspostSettled(h.log, ig, [fbDown, ig]), true, "the pre-filter stops re-checking the run");
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
