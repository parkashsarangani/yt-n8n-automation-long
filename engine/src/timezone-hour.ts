/**
 * Resolve "9pm in Europe/Berlin" (or any IANA zone) to today's UTC hour,
 * using Node's built-in Intl -- no timezone-database dependency.
 *
 * Scheduler.targetHourUtc is a single fixed number computed once, at service
 * construction. A hardcoded UTC hour that happens to line up with a local
 * clock time is only correct until the next DST transition, then silently
 * drifts an hour (documented, accepted tradeoff for the channel's original
 * US-timed slot in scheduler.ts's own comments). Recomputing the UTC hour
 * from the actual local-time target at every service start/restart removes
 * that drift entirely for a deployment that restarts at least twice a year
 * spanning a DST change -- true for this project, which redeploys on every
 * merge to main.
 */
export function localHourToUtcHour(timeZone: string, localHour: number, at: Date = new Date()): number {
  const offsetMinutes = timeZoneOffsetMinutes(timeZone, at);
  const utcHour = Math.floor((localHour * 60 - offsetMinutes) / 60) % 24;
  return ((utcHour % 24) + 24) % 24;
}

/** Minutes to ADD to UTC to get local time in `timeZone` at instant `at` (e.g. +120 for CEST). */
function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // formatToParts renders "at" AS IF it were the given local time; reinterpreting
  // those same numbers as UTC and diffing against the real instant yields the
  // zone's current offset, DST included, with no separate timezone database.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}
