import test from "node:test";
import assert from "node:assert/strict";
import { localHourToUtcHour } from "../src/timezone-hour.ts";

test("9pm Berlin resolves to 19:00 UTC in summer (CEST, UTC+2)", () => {
  // Late Oct 2026 is still before the DST changeover (last Sunday of October).
  assert.equal(localHourToUtcHour("Europe/Berlin", 21, new Date("2026-09-12T00:00:00Z")), 19);
  assert.equal(localHourToUtcHour("Europe/Berlin", 21, new Date("2026-10-24T00:00:00Z")), 19);
});

test("9pm Berlin resolves to 20:00 UTC in winter (CET, UTC+1) -- the drift a fixed UTC hour would miss", () => {
  assert.equal(localHourToUtcHour("Europe/Berlin", 21, new Date("2026-11-01T00:00:00Z")), 20);
  assert.equal(localHourToUtcHour("Europe/Berlin", 21, new Date("2026-01-15T00:00:00Z")), 20);
});

test("wraps past midnight UTC correctly", () => {
  // 1am Berlin in winter (CET, UTC+1) is midnight UTC the same day.
  assert.equal(localHourToUtcHour("Europe/Berlin", 1, new Date("2026-01-15T00:00:00Z")), 0);
  // A zone west of UTC wraps to the previous UTC day's hour.
  assert.equal(localHourToUtcHour("America/New_York", 0, new Date("2026-01-15T00:00:00Z")), 5);
});

test("a zone with no DST stays stable across the year", () => {
  assert.equal(localHourToUtcHour("UTC", 9, new Date("2026-06-01T00:00:00Z")), 9);
  assert.equal(localHourToUtcHour("UTC", 9, new Date("2026-12-01T00:00:00Z")), 9);
});
