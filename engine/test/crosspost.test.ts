/**
 * Shorts phase 2 (2026-09-29): Facebook/Instagram Reels cross-posting.
 * The Meta clients are exercised against a scripted fake Graph API; the
 * cross-post logic against fake targets and an in-memory run log.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FacebookReelsTarget, InstagramReelsTarget, type ReelsTarget } from "../src/providers/meta-reels.ts";
import { crosspostRun, reelCaption, CROSSPOST_MAX_ATTEMPTS, REEL_CAPTION_MAX } from "../src/crosspost.ts";
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

test("the Reel caption is title, description and up to five hashtags, within Instagram's limit", () => {
  const c = reelCaption({ title: "T", description: "D", tags: ["self improvement", "psychology", "a", "habits", "mind", "focus", "extra"] });
  assert.equal(c, "T\n\nD\n\n#selfimprovement #psychology #habits #mind #focus");
  assert.ok(reelCaption({ title: "T", description: "x".repeat(5000) }).length <= REEL_CAPTION_MAX);
});
