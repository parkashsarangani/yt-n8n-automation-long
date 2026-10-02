/**
 * One Short per day (operator 2026-10-02): the editor batch-edits several
 * Shorts; each validated cut is queued and they go out at 12:00 Berlin, one
 * per day, in the order they were UPLOADED (Drive createdTime). A broken cut
 * never blocks the queue; an unreadable state file stops releases instead of
 * risking a second one the same day.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VidGenService } from "../src/service.ts";
import { berlinClock, inReleaseOrder, releaseCandidates, releaseHour, RELEASE_QUEUE_NODE } from "../src/release-schedule.ts";
import { mp4_1080p_lasting } from "./mp4-fixture.ts";

// 2026-10-02 is CEST (UTC+2): 12:00 Berlin = 10:00Z.
const at = (iso: string) => new Date(iso);

test("Berlin clock, including the winter-time switch", () => {
  assert.deepEqual(berlinClock(at("2026-10-02T10:00:00Z")), { date: "2026-10-02", minutes: 12 * 60 });
  assert.deepEqual(berlinClock(at("2026-11-02T11:00:00Z")), { date: "2026-11-02", minutes: 12 * 60 }, "CET is UTC+1");
  assert.deepEqual(berlinClock(at("2026-10-02T22:30:00Z")), { date: "2026-10-03", minutes: 30 }, "after midnight Berlin is the next day");
});

test("DAILY_RELEASE_HOUR: default 12, 'off' publishes immediately, a typo warns and falls back to 12", () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(releaseHour(undefined, warn), 12);
  assert.equal(releaseHour("", warn), 12);
  assert.equal(releaseHour("18", warn), 18);
  assert.equal(releaseHour("off", warn), null);
  assert.equal(warnings.length, 0);
  assert.equal(releaseHour("of", warn), 12);
  assert.match(warnings[0]!, /"of" is not an hour/);
});

test("releaseCandidates: not before the slot, not twice a day, ordered by upload time, only uploads before the slot", () => {
  const queue = [
    { run_id: "b", queued_at: "2026-10-02T07:00:00Z", uploaded_at: "2026-10-01T15:00:00Z" },
    // Noticed first, uploaded earlier still: upload time wins.
    { run_id: "a", queued_at: "2026-10-02T06:00:00Z", uploaded_at: "2026-10-01T09:00:00Z" },
    { run_id: "late", queued_at: "2026-10-02T11:01:00Z", uploaded_at: "2026-10-02T11:00:00Z" }, // 13:00 Berlin
  ];
  assert.deepEqual(releaseCandidates(at("2026-10-02T09:59:00Z"), 12, undefined, queue), [], "11:59 Berlin: not yet");
  assert.deepEqual(releaseCandidates(at("2026-10-02T10:00:00Z"), 12, undefined, queue).map((q) => q.run_id), ["a", "b"]);
  assert.deepEqual(releaseCandidates(at("2026-10-02T16:00:00Z"), 12, "2026-10-02", queue), [], "already released today");
  assert.deepEqual(releaseCandidates(at("2026-10-03T10:00:00Z"), 12, "2026-10-02", [queue[2]!]).map((q) => q.run_id), ["late"], "after-noon upload goes tomorrow");
  assert.deepEqual(inReleaseOrder([{ run_id: "x", queued_at: "2026-10-02T08:00:00Z" }, { run_id: "y", queued_at: "2026-10-02T07:00:00Z" }]).map((q) => q.run_id),
    ["y", "x"], "no upload time: falls back to queue time");
});

interface Cut { id: string; createdTime: string; durationSec?: number; size?: number }

/** Several runs parked at editor_review, each with an (optional) final.mp4 in its own folder. */
async function makeService(runIds: string[]) {
  process.env["DAILY_RELEASE_HOUR"] = "12";
  const service = Object.create(VidGenService.prototype);
  service.editorReturnsInFlight = null;
  service.dataDir = await mkdtemp(path.join(tmpdir(), "release-"));
  const records: Array<Record<string, unknown> & { run_id: string }> = [];
  const released: string[] = [];
  const downloads: string[] = [];
  const waiting = new Set(runIds);
  const cuts = new Map<string, Cut>();
  let clock = at("2026-10-02T07:00:00Z");
  let failNextHandoff = false;
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
  const bytesFor = (c: Cut) => mp4_1080p_lasting(c.durationSec ?? 180);
  service.driveProvider = {
    listFiles: async (folder: string) => {
      const c = cuts.get(folder.slice(7));
      return c ? [{ id: c.id, name: "final.mp4", mimeType: "video/mp4", size: c.size ?? bytesFor(c).byteLength, createdTime: c.createdTime }] : [];
    },
    downloadFile: async (id: string) => {
      downloads.push(id);
      const c = [...cuts.values()].find((x) => x.id === id)!;
      return bytesFor(c);
    },
  };
  service.supplyEditorCut = async () => {
    if (failNextHandoff) { failNextHandoff = false; throw new Error("drive blip during hand-off"); }
  };
  service.decide = async (runId: string) => { released.push(runId); waiting.delete(runId); };

  const alerts: string[] = [];
  process.env["OPERATOR_ALERT_WEBHOOK_URL"] = "https://alerts.test/hook";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    alerts.push(String(JSON.parse(String(init.body)).reason ?? ""));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  return {
    service, records, released, downloads, alerts,
    /** The editor uploads (or replaces) a run's final.mp4 at Drive time `createdTime`. */
    upload: (run: string, createdTime: string, extra: Partial<Cut> = {}) => cuts.set(run, { id: `cut:${run}:${createdTime}`, createdTime, ...extra }),
    patch: (run: string, extra: Partial<Cut>) => cuts.set(run, { ...cuts.get(run)!, ...extra }),
    approveElsewhere: (run: string) => waiting.delete(run),
    failNextHandoff: () => { failNextHandoff = true; },
    stateFile: () => path.join(service.dataDir, "release-state.json"),
    setClock: (iso: string) => { clock = at(iso); },
    pass: () => service.checkEditorReturns(),
  };
}

test("a batch goes out one per day at 12:00 Berlin, in the order the cuts were UPLOADED, not noticed", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222", "run_cccc3333"]);
  // The editor uploads B, A, C within a minute; one poll notices all three
  // at once, in run-list order (A, B, C).
  s.upload("run_bbbb2222", "2026-10-02T06:58:00Z");
  s.upload("run_aaaa1111", "2026-10-02T06:58:30Z");
  s.upload("run_cccc3333", "2026-10-02T06:59:00Z");
  await s.pass();
  assert.deepEqual(s.released, [], "nothing before 12:00");
  assert.equal(s.records.filter((r) => r.node_id === RELEASE_QUEUE_NODE).length, 3, "all three queued");

  s.setClock("2026-10-02T10:00:30Z"); await s.pass();
  assert.deepEqual(s.released, ["run_bbbb2222"], "day 1: the first UPLOADED");
  s.setClock("2026-10-02T15:00:00Z"); await s.pass();
  assert.deepEqual(s.released, ["run_bbbb2222"], "only one per day");
  s.setClock("2026-10-03T10:01:00Z"); await s.pass();
  s.setClock("2026-10-04T10:01:00Z"); await s.pass();
  assert.deepEqual(s.released, ["run_bbbb2222", "run_aaaa1111", "run_cccc3333"]);
});

test("a cut still uploading at one poll keeps its upload-time place", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z", { size: 1 }); // Drive size != bytes: still uploading
  s.upload("run_bbbb2222", "2026-10-02T06:30:00Z");
  await s.pass();
  s.patch("run_aaaa1111", { size: undefined }); // upload finished
  s.setClock("2026-10-02T08:00:00Z"); await s.pass();
  s.setClock("2026-10-02T10:00:00Z"); await s.pass();
  assert.deepEqual(s.released, ["run_aaaa1111"], "uploaded first, released first -- though queued second");
});

test("a broken oldest cut does not block the queue: the next one goes out that day", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z");
  s.upload("run_bbbb2222", "2026-10-02T06:30:00Z");
  await s.pass();
  s.patch("run_aaaa1111", { durationSec: 20 }); // overwritten in place with a wrong export
  s.setClock("2026-10-02T10:00:00Z");
  const result = await s.pass();
  assert.deepEqual(s.released, ["run_bbbb2222"]);
  assert.deepEqual(result.failed_runs.map((f: { run_id: string }) => f.run_id), ["run_aaaa1111"]);
  assert.ok(s.alerts.some((a) => /could not be imported/.test(a)), "the broken one is reported");
});

test("a hand-off that fails after the slot is spent: no second try today, an alert says so, retried tomorrow", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z");
  s.upload("run_bbbb2222", "2026-10-02T06:30:00Z");
  await s.pass();
  s.failNextHandoff();
  s.setClock("2026-10-02T10:00:00Z"); await s.pass();
  assert.deepEqual(s.released, []);
  assert.ok(s.alerts.some((a) => /today's slot is used/.test(a)));
  assert.equal(JSON.parse(await readFile(s.stateFile(), "utf8")).last_release_date, "2026-10-02");
  s.setClock("2026-10-02T14:00:00Z"); await s.pass();
  assert.deepEqual(s.released, [], "B is not pushed out the same day instead");
  s.setClock("2026-10-03T10:00:00Z"); await s.pass();
  assert.deepEqual(s.released, ["run_aaaa1111"], "A retried first tomorrow");
});

test("a replaced final.mp4 goes to the back of the queue", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z");
  s.upload("run_bbbb2222", "2026-10-02T06:30:00Z");
  await s.pass();
  s.setClock("2026-10-02T07:30:00Z");
  s.upload("run_aaaa1111", "2026-10-02T07:20:00Z"); // new upload, new Drive id
  await s.pass();
  assert.equal(s.records.filter((r) => r.node_id === RELEASE_QUEUE_NODE && r.run_id === "run_aaaa1111").length, 2);
  s.setClock("2026-10-02T10:00:00Z"); await s.pass();
  assert.deepEqual(s.released, ["run_bbbb2222"], "the replacement does not keep the old place");
});

test("a queued run approved by hand elsewhere is dropped without using the slot", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z");
  s.upload("run_bbbb2222", "2026-10-02T06:30:00Z");
  await s.pass();
  s.approveElsewhere("run_aaaa1111");
  const before = s.downloads.length;
  s.setClock("2026-10-02T10:00:00Z"); await s.pass();
  assert.deepEqual(s.released, ["run_bbbb2222"]);
  assert.ok(!s.downloads.slice(before).some((d) => d.includes("run_aaaa1111")));
});

test("an unreadable state file pauses releases and alerts -- it never allows a second one", async () => {
  const s = await makeService(["run_aaaa1111"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z");
  await s.pass();
  await writeFile(s.stateFile(), "{ corrupt");
  s.setClock("2026-10-02T10:00:00Z");
  await s.pass();
  assert.deepEqual(s.released, []);
  assert.ok(s.alerts.some((a) => /daily release is paused/.test(a)));
});

test("a queued cut is downloaded to validate it once, and again only on its release day", async () => {
  const s = await makeService(["run_aaaa1111"]);
  s.setClock("2026-10-02T11:00:00Z"); // 13:00 Berlin: after today's slot
  s.upload("run_aaaa1111", "2026-10-02T10:59:00Z");
  for (let i = 0; i < 6; i++) await s.pass();
  assert.deepEqual(s.released, [], "uploaded after 12:00: waits for tomorrow");
  assert.equal(s.downloads.length, 1, "not re-downloaded every minute while queued");
  s.setClock("2026-10-03T10:00:00Z");
  await s.pass();
  assert.deepEqual(s.released, ["run_aaaa1111"]);
  assert.equal(s.downloads.length, 2, "checked again on its day before going out");
});

test("a restart does not release a second Short the same day", async () => {
  const s = await makeService(["run_aaaa1111", "run_bbbb2222"]);
  s.upload("run_aaaa1111", "2026-10-02T06:00:00Z");
  s.upload("run_bbbb2222", "2026-10-02T06:30:00Z");
  await s.pass();
  s.setClock("2026-10-02T10:30:00Z");
  await s.pass();
  // A fresh process (deploy) on the same day reads the same data dir.
  const again = Object.create(VidGenService.prototype);
  Object.assign(again, s.service, { editorReturnsInFlight: null });
  await again.checkEditorReturns();
  assert.equal(s.released.length, 1);
});
