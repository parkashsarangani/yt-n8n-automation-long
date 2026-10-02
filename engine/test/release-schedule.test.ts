/**
 * One Short per day (operator 2026-10-02): the editor batch-edits several
 * Shorts; each validated cut is queued and the oldest goes out at 12:00
 * Berlin, one per day, in upload order. A cut uploaded after the slot waits
 * for the next day.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VidGenService } from "../src/service.ts";
import { berlinClock, pickRelease, releaseHour, RELEASE_QUEUE_NODE } from "../src/release-schedule.ts";
import { mp4_1080p_lasting } from "./mp4-fixture.ts";

// 2026-10-02 is CEST (UTC+2): 12:00 Berlin = 10:00Z.
const at = (iso: string) => new Date(iso);

test("Berlin clock, including the winter-time switch", () => {
  assert.deepEqual(berlinClock(at("2026-10-02T10:00:00Z")), { date: "2026-10-02", minutes: 12 * 60 });
  assert.deepEqual(berlinClock(at("2026-11-02T11:00:00Z")), { date: "2026-11-02", minutes: 12 * 60 }, "CET is UTC+1");
  assert.deepEqual(berlinClock(at("2026-10-02T22:30:00Z")), { date: "2026-10-03", minutes: 30 }, "after midnight Berlin is the next day");
});

test("DAILY_RELEASE_HOUR: default 12, 'off' publishes immediately, junk falls back to 12", () => {
  assert.equal(releaseHour(undefined), 12);
  assert.equal(releaseHour(""), 12);
  assert.equal(releaseHour("18"), 18);
  assert.equal(releaseHour("off"), null);
  assert.equal(releaseHour("noon"), 12);
});

test("pickRelease: not before the slot, once per day, oldest first, only cuts queued before the slot", () => {
  const queue = [
    { run_id: "b", queued_at: "2026-10-01T15:00:00Z" },
    { run_id: "a", queued_at: "2026-10-01T09:00:00Z" },
    { run_id: "late", queued_at: "2026-10-02T11:00:00Z" }, // 13:00 Berlin today, after the slot
  ];
  assert.equal(pickRelease(at("2026-10-02T09:59:00Z"), 12, undefined, queue), null, "11:59 Berlin: not yet");
  assert.equal(pickRelease(at("2026-10-02T10:00:00Z"), 12, undefined, queue)?.run_id, "a", "12:00: the oldest");
  assert.equal(pickRelease(at("2026-10-02T16:00:00Z"), 12, "2026-10-02", queue), null, "already released today");
  assert.equal(pickRelease(at("2026-10-02T12:00:00Z"), 12, "2026-10-01", [queue[2]!]), null, "queued after today's slot: tomorrow");
  assert.equal(pickRelease(at("2026-10-03T10:00:00Z"), 12, "2026-10-02", [queue[2]!])?.run_id, "late", "...and it goes tomorrow");
});

/** A service with several runs parked at editor_review, each with a final.mp4 in its own folder. */
async function makeService(runIds: string[]) {
  process.env["DAILY_RELEASE_HOUR"] = "12";
  const service = Object.create(VidGenService.prototype);
  service.editorReturnsInFlight = null;
  service.dataDir = await mkdtemp(path.join(tmpdir(), "release-"));
  const records: Array<Record<string, unknown> & { run_id: string }> = [];
  const released: string[] = [];
  const downloads: string[] = [];
  const waiting = new Set(runIds);
  let clock = at("2026-10-02T07:00:00Z");
  service.releaseNow = () => clock;
  service.graph = { graph_id: "illustrated_story", version: "15" };
  service.runLog = { record: async (r: Record<string, unknown> & { run_id: string }) => { records.push(r); } };
  service.runRecords = async (id: string) => records.filter((r) => r.run_id === id);
  service.listRuns = () => [...waiting].map((id) => ({
    run_id: id,
    waiting: [{ node_id: "editor_review", artifact_id: `handoff:${id}`, reason: "human approval required" }],
    nodes: [{ node_id: "render", artifact_id: "render" }],
  }));
  service.store = {
    get: async (id: string) => id.startsWith("handoff:") ? { payload: { drive_folder_id: `folder:${id.slice(8)}` } }
      : id === "render" ? { payload: { scene_count: 4, degraded_scenes: 0, duration_sec: 180 } } : null,
  };
  const bytes = mp4_1080p_lasting(180);
  const uploaded = new Set<string>();
  service.driveProvider = {
    listFiles: async (folder: string) => uploaded.has(folder.slice(7))
      ? [{ id: `cut:${folder.slice(7)}`, name: "final.mp4", mimeType: "video/mp4", size: bytes.byteLength }] : [],
    downloadFile: async (id: string) => { downloads.push(id); return bytes; },
  };
  service.supplyEditorCut = async () => {};
  service.decide = async (runId: string) => { released.push(runId); waiting.delete(runId); };
  return {
    service, records, released, downloads,
    upload: (id: string) => uploaded.add(id),
    setClock: (iso: string) => { clock = at(iso); },
  };
}

test("a batch of cuts goes out one per day at 12:00 Berlin, in the order they were uploaded", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222", "run_cccc3333"]);
  // The editor finishes B first, then A, then C -- all before noon.
  s.setClock("2026-10-02T07:00:00Z"); s.upload("run_bbbb2222"); await s.service.checkEditorReturns();
  s.setClock("2026-10-02T07:05:00Z"); s.upload("run_aaaa1111"); await s.service.checkEditorReturns();
  s.setClock("2026-10-02T07:10:00Z"); s.upload("run_cccc3333"); await s.service.checkEditorReturns();
  assert.deepEqual(s.released, [], "nothing before 12:00");
  assert.equal(s.records.filter((r) => r.node_id === RELEASE_QUEUE_NODE).length, 3, "all three queued");

  s.setClock("2026-10-02T10:00:30Z"); await s.service.checkEditorReturns();
  assert.deepEqual(s.released, ["run_bbbb2222"], "day 1: the first uploaded");
  s.setClock("2026-10-02T15:00:00Z"); await s.service.checkEditorReturns();
  assert.deepEqual(s.released, ["run_bbbb2222"], "only one per day");

  s.setClock("2026-10-03T10:01:00Z"); await s.service.checkEditorReturns();
  s.setClock("2026-10-04T10:01:00Z"); await s.service.checkEditorReturns();
  assert.deepEqual(s.released, ["run_bbbb2222", "run_aaaa1111", "run_cccc3333"], "then the rest, a day apart, in upload order");
});

test("a queued cut is downloaded to validate it once, and again only on its release day", async () => {
  const s = await makeService(["run_aaaa1111"]);
  s.setClock("2026-10-02T11:00:00Z"); // 13:00 Berlin: after today's slot
  s.upload("run_aaaa1111");
  await s.service.checkEditorReturns();
  for (let i = 0; i < 5; i++) await s.service.checkEditorReturns();
  assert.deepEqual(s.released, [], "uploaded after 12:00: waits for tomorrow");
  assert.equal(s.downloads.length, 1, "not re-downloaded every minute while queued");
  s.setClock("2026-10-03T10:00:00Z");
  await s.service.checkEditorReturns();
  assert.deepEqual(s.released, ["run_aaaa1111"]);
  assert.equal(s.downloads.length, 2, "checked again on its day before going out");
});

test("a restart does not release a second Short the same day", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.setClock("2026-10-02T07:00:00Z");
  s.upload("run_aaaa1111"); s.upload("run_bbbb2222");
  await s.service.checkEditorReturns();
  s.setClock("2026-10-02T10:30:00Z");
  await s.service.checkEditorReturns();
  // A fresh process (deploy) on the same day reads the same data dir.
  const again = Object.create(VidGenService.prototype);
  Object.assign(again, s.service, { editorReturnsInFlight: null });
  await again.checkEditorReturns();
  assert.equal(s.released.length, 1);
});
