/**
 * Scheduler behaviour, driven by a fake clock.
 *
 * The two failure modes worth guarding are both silent. A scheduler that
 * overlaps a long job doubles the spend and interleaves writes with nothing in
 * the output to say so; a scheduler that dies on the first error keeps its
 * timer and looks alive while doing nothing at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type Job } from "../src/scheduler.ts";

const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });
const HOUR = 60 * 60 * 1000;

/** A controllable clock so tests never wait on real time. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function job(over: Partial<Job> & { id: string; run: Job["run"] }): Job {
  return {
    everyHours: 24,
    enabled: true,
    description: over.id,
    ...over,
  };
}

test("a job runs on the first tick, then not again until it is due", async () => {
  const c = clock();
  let runs = 0;
  const s = new Scheduler({
    jobs: [job({ id: "measure", everyHours: 24, run: async () => { runs += 1; } })],
    now: c.now,
    logger: silent(),
  });

  await s.tick();
  assert.equal(runs, 1, "first tick should run it");

  c.advance(23 * HOUR);
  await s.tick();
  assert.equal(runs, 1, "not due yet");

  c.advance(2 * HOUR);
  await s.tick();
  assert.equal(runs, 2, "now due");
});

test("a disabled job never fires but is still reported", async () => {
  // Visible rather than absent: a job you cannot see is a job you forget you
  // turned off.
  const c = clock();
  let runs = 0;
  const s = new Scheduler({
    jobs: [job({ id: "produce", enabled: false, run: async () => { runs += 1; } })],
    now: c.now,
    logger: silent(),
  });

  await s.tick();
  c.advance(100 * HOUR);
  await s.tick();

  assert.equal(runs, 0);
  const [st] = s.status();
  assert.equal(st!.enabled, false);
  assert.equal(st!.next_run, null);
});

test("a job that is still running does not start again", async () => {
  // Measurement takes minutes and a production run takes hours. Overlapping
  // would double-spend and interleave writes.
  const c = clock();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  const s = new Scheduler({
    jobs: [job({ id: "slow", everyHours: 1, run: async () => { started += 1; await gate; } })],
    now: c.now,
    logger: silent(),
  });

  const first = s.tick();
  await Promise.resolve();
  assert.equal(started, 1);

  c.advance(10 * HOUR);
  await s.tick();
  assert.equal(started, 1, "overlap must be refused, not queued");
  assert.equal(s.status()[0]!.running, true);

  release();
  await first;
  assert.equal(s.status()[0]!.running, false);
});

test("the interval is measured from completion, not from start", async () => {
  // A job that takes longer than its own interval would otherwise be
  // permanently due and run back to back forever.
  const c = clock();
  let runs = 0;
  const s = new Scheduler({
    jobs: [
      job({
        id: "long",
        everyHours: 1,
        run: async () => { runs += 1; c.advance(3 * HOUR); },
      }),
    ],
    now: c.now,
    logger: silent(),
  });

  await s.tick();
  assert.equal(runs, 1);
  await s.tick();
  assert.equal(runs, 1, "the three hours it spent running must not count as waiting");

  c.advance(2 * HOUR);
  await s.tick();
  assert.equal(runs, 2);
});

test("a failing job is recorded and the schedule continues", async () => {
  const c = clock();
  let good = 0;
  const s = new Scheduler({
    jobs: [
      job({ id: "bad", everyHours: 1, run: async () => { throw new Error("analytics 500"); } }),
      job({ id: "good", everyHours: 1, run: async () => { good += 1; } }),
    ],
    now: c.now,
    logger: silent(),
  });

  await s.tick();

  assert.equal(good, 1, "one job failing must not skip the others");
  const bad = s.status().find((j) => j.id === "bad")!;
  assert.match(bad.last_error ?? "", /analytics 500/);
  assert.equal(bad.running, false, "a thrown job must not stay marked running");

  // And it recovers on the next due tick.
  c.advance(2 * HOUR);
  await s.tick();
  assert.equal(s.status().find((j) => j.id === "bad")!.runs, 2);
});

test("a successful run clears a previous error", async () => {
  const c = clock();
  let fail = true;
  const s = new Scheduler({
    jobs: [
      job({
        id: "flaky",
        everyHours: 1,
        run: async () => { if (fail) throw new Error("transient"); },
      }),
    ],
    now: c.now,
    logger: silent(),
  });

  await s.tick();
  assert.match(s.status()[0]!.last_error ?? "", /transient/);

  fail = false;
  c.advance(2 * HOUR);
  await s.tick();
  assert.equal(s.status()[0]!.last_error, null, "a stale error would misreport a healthy job");
});

test("runNow ignores the schedule but still refuses overlap", async () => {
  const c = clock();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  const s = new Scheduler({
    jobs: [job({ id: "measure", everyHours: 24, run: async () => { runs += 1; await gate; } })],
    now: c.now,
    logger: silent(),
  });

  const inflight = s.runNow("measure");
  await Promise.resolve();
  assert.equal(runs, 1);

  await assert.rejects(() => s.runNow("measure"), /already running/);

  release();
  await inflight;
  await s.runNow("measure");
  assert.equal(runs, 2, "once finished it can be triggered again");
});

test("runNow on an unknown job is an error, not a silent no-op", async () => {
  const s = new Scheduler({ jobs: [], logger: silent() });
  await assert.rejects(() => s.runNow("nope"), /unknown job/);
});

test("status reports when each job is next due", async () => {
  const c = clock(Date.parse("2026-08-15T12:00:00.000Z"));
  const s = new Scheduler({
    jobs: [job({ id: "measure", everyHours: 6, run: async () => { } })],
    now: c.now,
    logger: silent(),
  });

  assert.equal(s.status()[0]!.last_run, null);
  assert.equal(s.status()[0]!.next_run, null, "never run yet means no next time to report");

  await s.tick();
  const st = s.status()[0]!;
  assert.equal(st.last_run, "2026-08-15T12:00:00.000Z");
  assert.equal(st.next_run, "2026-08-15T18:00:00.000Z");
  assert.equal(st.runs, 1);
});

test("stop() halts the timer", async () => {
  const s = new Scheduler({
    jobs: [job({ id: "x", run: async () => { } })],
    tickMs: 1,
    logger: silent(),
  });
  s.start();
  s.stop();
  // Nothing to assert beyond it not throwing and not leaving a handle behind;
  // node:test would hang on an un-cleared interval.
  assert.ok(true);
});
