/**
 * checkEditorReturns() consumes a human editor's finished cut from Drive and
 * resumes the run straight into publishing. Once EDITOR_RETURN_WATCH_ENABLED
 * is on, everything below happens without a human in the loop and ends in a
 * public YouTube upload, so the failure modes worth guarding are the ones
 * that would publish the wrong bytes, or publish twice:
 *
 *  - Drive lists a file when it is created, not when the upload completes,
 *    so a poll (or a creation-triggered webhook) can read a truncated cut.
 *  - The scheduler refuses to overlap its own jobs, but a webhook calling the
 *    method directly bypasses that, so two passes can race the same file.
 *
 * Before this file the method had no test coverage at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";
// Real MP4 bytes: checkEditorReturns runs the actual geometry assertion.
import { mp4_1080p as mp4 } from "./mp4-fixture.ts";

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  bytes: Uint8Array;
}

/**
 * A service with just enough wired up to drive checkEditorReturns(): one run
 * parked at editor_review, a fake Drive holding whatever the test puts there,
 * and stubs standing in for the resume path.
 */
function makeService(files: FakeFile[], opts: { onDownload?: (id: string) => void } = {}) {
  const calls: string[] = [];
  const service = Object.create(VidGenService.prototype);
  service.editorReturnsInFlight = null;
  // Consumption is read back from the run log, so the fake has to behave like
  // one: records written during a pass are visible to the next.
  const records: Array<Record<string, unknown>> = [];
  service.graph = { graph_id: "illustrated_story", version: "15" };
  service.runLog = { record: async (r: Record<string, unknown>) => { records.push(r); } };
  service.runRecords = async () => records;

  service.listRuns = () => [{
    run_id: "run_editor01-aaaa",
    waiting: [{ node_id: "editor_review", artifact_id: "sha256:handoff", reason: "human approval required" }],
    nodes: [{ node_id: "render", artifact_id: "sha256:render" }],
  }];

  service.store = {
    get: async (id: string) => {
      if (id === "sha256:handoff") return { payload: { drive_folder_id: "folder-1" } };
      if (id === "sha256:render") return { payload: { scene_count: 4, degraded_scenes: 0, duration_sec: 180 } };
      return null;
    },
  };

  service.driveProvider = {
    listFiles: async () => files.map(({ bytes: _bytes, ...meta }) => ({ ...meta })),
    downloadFile: async (id: string) => {
      opts.onDownload?.(id);
      calls.push(`download:${id}`);
      const file = files.find((f) => f.id === id);
      if (!file) throw new Error(`unknown file ${id}`);
      return file.bytes;
    },
  };

  service.supplyEditorCut = async () => { calls.push("supplyEditorCut"); };
  service.decide = async (_runId: string, nodeId: string) => { calls.push(`decide:${nodeId}`); };

  return { service, calls, records };
}

/**
 * `size` is what Drive *now* reports. Passing a value other than the byte
 * length is the mid-upload case: we downloaded one thing, the file is another.
 */
function finalCut(bytes: Uint8Array, size: number | undefined = bytes.byteLength): FakeFile {
  return { id: "file-final", name: "final.mp4", mimeType: "video/mp4", size, bytes };
}

test("a settled final.mp4 is applied and the gate approved", async () => {
  const { service, calls } = makeService([finalCut(mp4())]);
  const result = await service.checkEditorReturns();

  assert.deepEqual(result, { checked: 1, advanced: 1 });
  assert.deepEqual(calls, ["download:file-final", "supplyEditorCut", "decide:editor_review"]);
});

test("a file still being uploaded is left alone until it settles", async () => {
  // We downloaded the whole file as it stood, but Drive now reports a larger
  // size: the editor's upload was still in flight. Publishing that truncated cut is unrecoverable.
  const { service, calls } = makeService([finalCut(mp4(), 4096)]);
  const result = await service.checkEditorReturns();

  assert.deepEqual(result, { checked: 1, advanced: 0 });
  assert.ok(!calls.includes("supplyEditorCut"), "a mid-upload cut must never be applied");
  assert.ok(!calls.includes("decide:editor_review"), "a mid-upload cut must never approve the gate");
});

test("an unsized file is skipped rather than trusted", async () => {
  // Drive omits size for some file types. Unverifiable is not the same as
  // complete, and this codebase skips rather than guesses.
  // Built directly rather than via finalCut(): passing `undefined` to a
  // defaulted parameter would just re-apply the default.
  const { service, calls } = makeService([
    { id: "file-final", name: "final.mp4", mimeType: "video/mp4", bytes: mp4() },
  ]);

  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  assert.ok(!calls.includes("supplyEditorCut"));
});

test("the cut is recognised however the editor named or exported it", async () => {
  // package.md asks for final.mp4, but Drive appends " (1)" to a re-uploaded
  // file on its own, and editors reasonably export .mov or add a version.
  for (const name of ["final.mp4", "Final.MP4", "final (1).mp4", "final_v2.mp4", "final.mov", "final.m4v"]) {
    const { service, calls } = makeService([
      { id: "file-final", name, mimeType: "video/mp4", size: mp4().byteLength, bytes: mp4() },
    ]);
    assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 1 }, `expected ${name} to be imported`);
    assert.ok(calls.includes("decide:editor_review"));
  }
});

test("our own draft is never mistaken for the editor's cut", async () => {
  // draft.mp4 is a video file we put in the folder ourselves. Publishing it
  // would push the unedited draft live.
  const { service, calls } = makeService([
    { id: "file-draft", name: "draft.mp4", mimeType: "video/mp4", size: mp4().byteLength, bytes: mp4() },
    { id: "file-thumb", name: "thumbnail.png", mimeType: "image/png", size: 4, bytes: new Uint8Array(4) },
  ]);

  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  assert.ok(!calls.includes("decide:editor_review"));
});

test("two possible cuts are refused rather than guessed between", async () => {
  const { service, calls } = makeService([
    { id: "a", name: "final.mp4", mimeType: "video/mp4", size: mp4().byteLength, bytes: mp4() },
    { id: "b", name: "final_v2.mp4", mimeType: "video/mp4", size: mp4().byteLength, bytes: mp4() },
  ]);

  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  assert.ok(!calls.includes("decide:editor_review"), "publishing the wrong cut is not recoverable");
});

test("a folder without final.mp4 advances nothing", async () => {
  const { service, calls } = makeService([
    { id: "file-draft", name: "draft.mp4", mimeType: "video/mp4", size: 10, bytes: new Uint8Array(10) },
  ]);

  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  assert.deepEqual(calls, []);
});

test("a returned thumbnail rides along with the cut, and its absence is not an error", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const supplied: Array<{ media_type: string } | undefined> = [];
  const build = (files: FakeFile[]) => {
    const { service, calls } = makeService(files);
    service.supplyEditorCut = async (_id: string, _video: unknown, thumb?: { media_type: string }) => {
      calls.push("supplyEditorCut");
      supplied.push(thumb);
    };
    return service;
  };

  // With a thumbnail present it is passed through for publish to prefer.
  await build([
    finalCut(mp4()),
    { id: "t", name: "thumbnail-final.png", mimeType: "image/png", size: png.byteLength, bytes: png },
  ]).checkEditorReturns();
  assert.equal(supplied[0]?.media_type, "image/png");

  // Without one the cut still publishes -- our own thumbnail is used.
  await build([finalCut(mp4())]).checkEditorReturns();
  assert.equal(supplied[1], undefined);
});

test("our own thumbnail.png is never mistaken for a returned one", async () => {
  // thumbnail.png and thumbnail-artwork.png are what the editor works *from*.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { service } = makeService([
    finalCut(mp4()),
    { id: "t1", name: "thumbnail.png", mimeType: "image/png", size: png.byteLength, bytes: png },
    { id: "t2", name: "thumbnail-artwork.png", mimeType: "image/png", size: png.byteLength, bytes: png },
  ]);
  let passedThumbnail: unknown = "untouched";
  service.supplyEditorCut = async (_id: string, _video: unknown, thumb?: unknown) => { passedThumbnail = thumb; };

  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 1 });
  assert.equal(passedThumbnail, undefined);
});

test("a cut that was handed over but never recorded as published needs a human", async () => {
  // The dangerous window: the hand-over is durably marked before the gate is
  // approved, so a process that dies between YouTube accepting the upload and
  // the publish record being written leaves no way to tell "never published"
  // from "already live". Re-importing could put the episode on the channel
  // twice, which cannot be undone, so this is the one case that stops and asks.
  const { service, calls } = makeService([finalCut(mp4())]);
  service.decide = async () => {
    calls.push("decide:editor_review");
    throw new Error("process died mid-resume");
  };

  const originalFetch = globalThis.fetch;
  const posted: Array<{ reason: string; text: string }> = [];
  process.env["OPERATOR_ALERT_WEBHOOK_URL"] = "https://example.test/hook";
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });

    // A later pass -- including one after a restart, since this is read from
    // the run log and not from memory -- must not silently republish.
    const second = await service.checkEditorReturns();
    assert.deepEqual(second, { checked: 1, advanced: 0 });
    assert.equal(calls.filter((c) => c === "supplyEditorCut").length, 1, "the cut must not be re-imported");
    assert.ok(
      posted.some((p) => /may already have been published/.test(p.reason)),
      "the operator must be asked to check the channel",
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPERATOR_ALERT_WEBHOOK_URL"];
  }
});

test("a cut already recorded as published is left alone, silently", async () => {
  // The normal post-publish state. No alert: nothing is wrong.
  const { service, calls, records } = makeService([finalCut(mp4())]);
  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 1 });

  records.push({ run_id: "run_editor01-aaaa", node_id: "publish", transformation: "publish", inputs: [], output: "sha256:episode" });
  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  assert.equal(calls.filter((c) => c === "decide:editor_review").length, 1);
});

test("an upload we cannot import alerts a human instead of waiting forever", async () => {
  // The run is *waiting*, not failing, so nothing else would ever surface
  // this: the editor uploads final.mvo, believes they are done, and without
  // an alert the episode silently never ships.
  const { service, calls } = makeService([
    { id: "x", name: "final.mvo", mimeType: "video/quicktime", size: 10, bytes: new Uint8Array(10) },
  ]);

  const originalFetch = globalThis.fetch;
  const posted: Array<{ reason: string; text: string }> = [];
  process.env["OPERATOR_ALERT_WEBHOOK_URL"] = "https://example.test/hook";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPERATOR_ALERT_WEBHOOK_URL"];
  }

  assert.ok(!calls.includes("decide:editor_review"));
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.reason, /cannot import/);
  assert.match(posted[0]!.text, /final\.mvo/, "the alert must name the file so it can be renamed");
});

test("a webhook racing the poll collapses onto one pass, downloading once", async () => {
  let downloads = 0;
  const { service } = makeService([finalCut(mp4())], { onDownload: () => { downloads++; } });

  // Both callers start before either finishes -- the scheduler's overlap guard
  // does not cover a direct call.
  const [a, b] = await Promise.all([service.checkEditorReturns(), service.checkEditorReturns()]);

  assert.equal(downloads, 1, "the same cut must not be downloaded twice");
  assert.deepEqual(a, { checked: 1, advanced: 1 });
  assert.deepEqual(b, a, "the second caller receives the in-flight pass's result");
});

test("the same cut is never consumed twice across sequential passes", async () => {
  // If a later pass still sees the run waiting (resume is fire-and-forget),
  // the file must not be published a second time.
  const { service, calls } = makeService([finalCut(mp4())]);

  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 1 });
  assert.deepEqual(await service.checkEditorReturns(), { checked: 1, advanced: 0 });
  assert.equal(calls.filter((c) => c === "decide:editor_review").length, 1);
});

test("one run's failure does not stop the others being checked", async () => {
  const { service, calls } = makeService([finalCut(mp4())]);
  service.listRuns = () => [
    { run_id: "run_broken01", waiting: [{ node_id: "editor_review", artifact_id: "sha256:missing" }], nodes: [] },
    {
      run_id: "run_editor01-aaaa",
      waiting: [{ node_id: "editor_review", artifact_id: "sha256:handoff" }],
      nodes: [{ node_id: "render", artifact_id: "sha256:render" }],
    },
  ];

  assert.deepEqual(await service.checkEditorReturns(), { checked: 2, advanced: 1 });
  assert.ok(calls.includes("decide:editor_review"));
});
