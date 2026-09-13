import test from "node:test";
import assert from "node:assert/strict";
import { DriveProvider } from "../src/providers/drive.ts";

test("DriveProvider hits the expected Drive v3 endpoints with a bearer token", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/files?fields=id")) return new Response(JSON.stringify({ id: "folder1" }), { status: 200 });
    if (url.includes("uploadType=multipart")) return new Response(JSON.stringify({ id: "file1" }), { status: 200 });
    if (url.includes("/files?q=")) return new Response(JSON.stringify({ files: [{ id: "file1", name: "final.mp4", mimeType: "video/mp4" }] }), { status: 200 });
    if (url.endsWith("/files/file1?alt=media")) return new Response(new Uint8Array([9, 9]), { status: 200 });
    return new Response("not found", { status: 404 });
  };

  const drive = new DriveProvider({ accessToken: "tok", fetchImpl });
  const folderId = await drive.createFolder("2026-09-14", "root");
  assert.equal(folderId, "folder1");

  const fileId = await drive.uploadFile(folderId, "draft.mp4", new Uint8Array([1, 2]), "video/mp4");
  assert.equal(fileId, "file1");

  const files = await drive.listFiles(folderId);
  assert.deepEqual(files, [{ id: "file1", name: "final.mp4", mimeType: "video/mp4" }]);

  const bytes = await drive.downloadFile("file1");
  assert.deepEqual([...bytes], [9, 9]);

  assert.equal(calls.length, 4);
});
