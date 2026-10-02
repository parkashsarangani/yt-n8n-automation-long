/**
 * One Short per day (operator 2026-10-02, at the editor's request): the
 * editor finishes several Shorts in a batch and drops each final cut into
 * its Drive folder; the system publishes them one a day, at 12:00 Berlin
 * time, in the order the cuts were uploaded.
 *
 * A returned cut is validated as before and then QUEUED -- a run-log tag
 * record (node_id RELEASE_QUEUE_NODE, graph_id null, inputs [drive file id],
 * started_at = when it was first validated) -- instead of being handed to
 * publish. Order is the Drive upload time (createdTime), so cuts dropped
 * between two polls, or one that was still uploading at a poll, keep the
 * editor's order; the queue time is only the fallback and tie-break.
 *
 * At or after the daily slot the cuts uploaded BEFORE that slot are tried in
 * order and the first one that re-validates is released (finalize -> QA ->
 * publish, then the Facebook/Instagram cross-post); a broken cut never
 * blocks the ones behind it. A cut uploaded after 12:00 waits for the next
 * day. At most one release per Berlin day, remembered in a state file.
 */

export const RELEASE_QUEUE_NODE = "release_queue";
export const DEFAULT_RELEASE_HOUR = 12;
const TZ = "Europe/Berlin";

/** DAILY_RELEASE_HOUR (0-23, Berlin); "off" publishes each cut immediately, as before. */
export function releaseHour(value: string | undefined, warn: (m: string) => void = console.warn): number | null {
  const v = value?.trim().toLowerCase();
  if (v === "off" || v === "none") return null;
  if (!v) return DEFAULT_RELEASE_HOUR;
  const h = Number(v);
  if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  warn(`[release] DAILY_RELEASE_HOUR="${value}" is not an hour 0-23 or "off"; using ${DEFAULT_RELEASE_HOUR}:00`);
  return DEFAULT_RELEASE_HOUR;
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
  /** When the cut first validated (ISO 8601). */
  queued_at: string;
  /** When the editor uploaded it (Drive createdTime); the order key when known. */
  uploaded_at?: string;
}

const orderKey = (q: QueuedCut) => Date.parse(q.uploaded_at ?? q.queued_at);
const byUploadOrder = (a: QueuedCut, b: QueuedCut) => orderKey(a) - orderKey(b) || a.queued_at.localeCompare(b.queued_at);

/** The queue in release order. */
export function inReleaseOrder<T extends QueuedCut>(queue: T[]): T[] {
  return [...queue].sort(byUploadOrder);
}

/**
 * The cuts that may be released now, in order: empty before today's slot or
 * once something was released today; otherwise every cut uploaded before
 * today's slot. The caller releases the first one that still validates.
 */
export function releaseCandidates<T extends QueuedCut>(now: Date, hour: number, lastReleaseDate: string | undefined, queue: T[]): T[] {
  const today = berlinClock(now);
  if (today.minutes < hour * 60 || lastReleaseDate === today.date) return [];
  const beforeSlot = (q: QueuedCut) => {
    const c = berlinClock(new Date(orderKey(q)));
    return c.date < today.date || (c.date === today.date && c.minutes < hour * 60);
  };
  return inReleaseOrder(queue.filter(beforeSlot));
}
