import test from "node:test";
import assert from "node:assert/strict";
import { makeEditorPackageWorker } from "../src/workers/editor-package.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { FakeDriveProvider } from "../src/providers/fake.ts";
import type { Artifact } from "../src/artifact.ts";
import type { WorkerContext } from "../src/runner.ts";

function ctxWith(drive = new FakeDriveProvider()) {
  const blobs = new MemoryBlobStore();
  return {
    blobs,
    logger: console,
    progress: async () => {},
    media: { drive },
  } as unknown as WorkerContext;
}

test("editor package uploads the draft and records a beat per scene", async () => {
  const ctx = ctxWith();
  const blobs = ctx.blobs;
  const video = await blobs.put(new Uint8Array([1, 2, 3]), { role: "video", media_type: "video/mp4" });
  const thumb = await blobs.put(new Uint8Array([4, 5]), { role: "thumbnail", media_type: "image/png" });
  const captions = await blobs.put(new TextEncoder().encode("1\n00:00:00,000 --> 00:00:02,000\nA colleague cuts across.\n"), { role: "captions", media_type: "application/x-subrip" });

  const inputs = {
    script: {
      payload: {
        scenes: [
          { scene_index: 0, point: "[scenario] set up the situation", narration: "A colleague cuts across the point you were making." },
          { scene_index: 1, point: "[payoff] land the takeaway", narration: "The result is a calmer conversation.", is_outro: true },
        ],
      },
    } as Artifact,
    voice: { payload: { clips: [{ scene_index: 0, duration_sec: 10 }, { scene_index: 1, duration_sec: 5 }] } } as Artifact,
    render: { payload: { video_uri: video.uri, media_type: "video/mp4" }, blobs: [video, captions] } as Artifact,
    seo: { payload: { title: "A calmer response", description: "How to handle a colleague who keeps cutting you off.", tags: ["communication", "workplace"] } } as Artifact,
    thumbnail: { payload: { thumbnail_uri: thumb.uri, media_type: "image/png", background: "gradient" } } as Artifact,
  };

  const worker = makeEditorPackageWorker({ rootFolderId: "root" });
  const out = await worker.execute(inputs, ctx);
  const payload = out.payload as { drive_folder_id: string; drive_folder_url: string; scenes: Array<{ scene_index: number; start_sec: number; duration_sec: number; search_terms?: string[] }> };

  assert.equal(payload.scenes.length, 2);
  assert.equal(payload.scenes[0]!.start_sec, 0);
  assert.equal(payload.scenes[0]!.duration_sec, 10);
  assert.equal(payload.scenes[1]!.start_sec, 10);
  // The outro scene never gets search-term suggestions -- there is no footage
  // decision to help with on the closing line.
  assert.equal(payload.scenes[1]!.search_terms, undefined);
  assert.ok(payload.scenes[0]!.search_terms && payload.scenes[0]!.search_terms.length > 0);

  const drive = (ctx.media.drive as FakeDriveProvider);
  const files = await drive.listFiles(payload.drive_folder_id);
  assert.deepEqual(files.map((f) => f.name).sort(), ["captions.srt", "credits.json", "draft.mp4", "package.md", "thumbnail.png"]);
  const md = new TextDecoder().decode(await drive.downloadFile(files.find(f=>f.name==="package.md")!.id));
  assert.match(md,/A colleague cuts across the point you were making/);
  assert.match(md,/Preserve the narration timing/);
  assert.match(md,/THUMBNAIL NEEDS REPLACEMENT/);
  assert.doesNotMatch(md,/already final/);
  assert.deepEqual(await drive.downloadFile(files.find(f=>f.name==="captions.srt")!.id),await blobs.get(captions.uri));
  const again = await worker.execute(inputs,ctx);
  assert.equal((again.payload as any).drive_folder_id,payload.drive_folder_id);
  assert.equal((await drive.listFiles(payload.drive_folder_id)).length,5);
});

test("a scene already covered by footage gets no search-term suggestion", async () => {
  const ctx = ctxWith();
  const blobs = ctx.blobs;
  const video = await blobs.put(new Uint8Array([1]), { role: "video", media_type: "video/mp4" });
  const credits = await blobs.put(
    new TextEncoder().encode(JSON.stringify([{ id: "a", creator: "c", source_url: "https://example.com/a", license_url: "https://example.com/l", credit: "Credit A", sha256: "x", scene_index: 0 }])),
    { role: "footage_credits", media_type: "application/json" },
  );

  const thumb = await blobs.put(new Uint8Array([4, 5]), { role: "thumbnail", media_type: "image/png" });
  const inputs = {
    script: { payload: { scenes: [{ scene_index: 0, point: "[scenario] intro", narration: "A colleague cuts across the point you were making." }] } } as Artifact,
    voice: { payload: { clips: [{ scene_index: 0, duration_sec: 8 }] } } as Artifact,
    render: { payload: { video_uri: video.uri, media_type: "video/mp4" }, blobs: [video, credits] } as Artifact,
    seo: { payload: { title: "A calmer response", description: "How to handle a colleague who keeps cutting you off.", tags: ["communication"] } } as Artifact,
    thumbnail: { payload: { thumbnail_uri: thumb.uri, media_type: "image/png" } } as Artifact,
  };

  const out = await makeEditorPackageWorker({ rootFolderId: "root" }).execute(inputs, ctx);
  const scene = (out.payload as { scenes: Array<{ visual_summary: string; search_terms?: string[] }> }).scenes[0]!;
  assert.match(scene.visual_summary, /Credit A/);
  assert.equal(scene.search_terms, undefined);
});

test("editor package fails clearly when Drive is not configured", async () => {
  const ctx = { blobs: new MemoryBlobStore(), logger: console, progress: async () => {}, media: {} } as unknown as WorkerContext;
  await assert.rejects(
    () => makeEditorPackageWorker({ rootFolderId: "root" }).execute({} as Record<string, Artifact>, ctx),
    /requires a Drive provider/,
  );
});
