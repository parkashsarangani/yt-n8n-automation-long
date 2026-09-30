/**
 * Instagram only publishes from a public URL (2026-09-30): a Reels-safe
 * re-encode, shared from Drive only for as long as the post takes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DrivePublicVideoHost, PUBLIC_REELS_FOLDER, STALE_AFTER_MS, reelEncodeArgs } from "../src/reel-public-video.ts";

const NOW = Date.parse("2026-09-30T18:00:00Z");

function fakeDrive(existing: Array<{ id: string; createdTime: string }> = [], folderExists = true) {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? init.body : init.body instanceof Blob ? "<blob>" : "" });
    const q = decodeURIComponent(url);
    if (method === "GET" && q.includes(`name = '${PUBLIC_REELS_FOLDER}'`)) return Response.json({ files: folderExists ? [{ id: "TMPDIR" }] : [] });
    if (method === "GET" && q.includes("'TMPDIR' in parents")) return Response.json({ files: existing });
    if (method === "POST" && url.endsWith("/files?fields=id")) return Response.json({ id: "TMPDIR" });
    if (method === "POST" && url.includes("uploadType=multipart")) return Response.json({ id: "F1" });
    if (method === "POST" && url.includes("/permissions")) return Response.json({ id: "anyone" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const host = new DrivePublicVideoHost({ token: async () => "drive-token", parentFolderId: "ROOT", fetchImpl, now: () => NOW });
  return { host, calls };
}

test("publish: upload into the temp folder, share with anyone, return a direct download URL; release deletes it", async () => {
  const { host, calls } = fakeDrive();
  const copy = await host.publish("reel-tmp-abc.mp4", new Uint8Array([1, 2, 3]));
  assert.equal(copy.url, "https://drive.usercontent.google.com/download?id=F1&export=download&confirm=t");
  const perm = calls.find((c) => c.url.includes("/F1/permissions"))!;
  assert.deepEqual(JSON.parse(perm.body), { role: "reader", type: "anyone" });
  assert.ok(!calls.some((c) => c.method === "DELETE"), "still public until released");
  await copy.release();
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/files/F1")));
});

test("the temp folder is created under the Drive root when missing", async () => {
  const { host, calls } = fakeDrive([], false);
  await host.publish("reel-tmp-abc.mp4", new Uint8Array([1]));
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/files?fields=id"))!;
  assert.deepEqual(JSON.parse(create.body), { name: PUBLIC_REELS_FOLDER, mimeType: "application/vnd.google-apps.folder", parents: ["ROOT"] });
});

test("leftovers a crash left public are deleted; a copy in use by a running post is not", async () => {
  const old = new Date(NOW - STALE_AFTER_MS - 60_000).toISOString();
  const fresh = new Date(NOW - 60_000).toISOString();
  const { host, calls } = fakeDrive([{ id: "OLD", createdTime: old }, { id: "FRESH", createdTime: fresh }]);
  assert.equal(await host.sweep(), 1);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/files/OLD")));
  assert.ok(!calls.some((c) => c.method === "DELETE" && c.url.endsWith("/files/FRESH")));
});

test("the re-encode fixes what Instagram rejects in editor cuts: H.264, constant 30 fps, AAC 48 kHz, index first", () => {
  const a = reelEncodeArgs("in.mp4", "out.mp4").join(" ");
  assert.match(a, /-c:v libx264/);
  assert.match(a, /-fps_mode cfr -r 30/);
  assert.match(a, /-c:a aac .*-ar 48000/);
  assert.match(a, /-movflags \+faststart/);
  assert.doesNotMatch(a, /scale|-s /, "keeps 1080x1920");
});
