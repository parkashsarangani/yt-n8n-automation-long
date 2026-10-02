/**
 * One Short per day (operator 2026-10-02, at the editor's request): the
 * editor finishes several Shorts in a batch and drops each final cut into
 * its Drive folder; the system publishes them one a day, at 12:00 Berlin
 * time, in the order the cuts were uploaded.
 *
 * A returned cut is validated as before and then QUEUED -- a run-log tag
 * record (node_id RELEASE_QUEUE_NODE, graph_id null, inputs [drive file id],
 * started_at = queue time) -- instead of being handed to publish. At or
 * after the daily slot, the oldest cut queued BEFORE that slot is released
 * (finalize -> QA -> publish, then the Facebook/Instagram cross-post). A cut
 * uploaded after 12:00 waits for the next day. At most one release per
 * Berlin day, remembered in a small state file so a restart cannot release
 * a second one.
 */

export const RELEASE_QUEUE_NODE = "release_queue";
export const DEFAULT_RELEASE_HOUR = 12;
const TZ = "Europe/Berlin";

/** DAILY_RELEASE_HOUR (0-23, Berlin); "off" publishes each cut immediately, as before. */
export function releaseHour(value: string | undefined): number | null {
  const v = value?.trim().toLowerCase();
  if (v === "off" || v === "none") return null;
  if (!v) return DEFAULT_RELEASE_HOUR;
  const h = Number(v);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_RELEASE_HOUR;
}

/** Berlin calendar date (YYYY-MM-DD) and minutes since local midnight. */
export function berlinClock(at: Date): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, minutes: Number(parts["hour"]) * 60 + Number(parts["minute"]) };
}

export interface QueuedCut {
  run_id: string;
  queued_at: string;
}

/**
 * Which queued cut to release now, if any: only at/after today's slot, only
 * if nothing was released today, only a cut queued before today's slot, and
 * the oldest of those.
 */
export function pickRelease(now: Date, hour: number, lastReleaseDate: string | undefined, queue: QueuedCut[]): QueuedCut | null {
  const today = berlinClock(now);
  if (today.minutes < hour * 60 || lastReleaseDate === today.date) return null;
  const beforeSlot = (q: QueuedCut) => {
    const c = berlinClock(new Date(q.queued_at));
    return c.date < today.date || (c.date === today.date && c.minutes < hour * 60);
  };
  return queue.filter(beforeSlot).sort((a, b) => a.queued_at.localeCompare(b.queued_at))[0] ?? null;
}

/** 1-based position of each queued cut in release order (for logs). */
export function queuePositions(queue: QueuedCut[]): Map<string, number> {
  return new Map([...queue].sort((a, b) => a.queued_at.localeCompare(b.queued_at)).map((q, i) => [q.run_id, i + 1]));
}
