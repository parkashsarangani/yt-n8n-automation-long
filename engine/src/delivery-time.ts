/** Calendar slots are resolved on every tick, including DST transitions. */
export function localParts(ms: number, timeZone = "Europe/Berlin") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function localSlot(now: number, hour: number, timeZone: string, tomorrow = false): number {
  const date = localParts(now, timeZone).date;
  const anchor = Date.parse(`${date}T12:00:00Z`) + (tomorrow ? 86_400_000 : 0);
  const day = new Date(anchor).toISOString().slice(0, 10);
  // Search real instants: Berlin's 03:00 and 05:00 exist exactly once even on DST days.
  for (let ms = anchor - 26 * 3_600_000; ms <= anchor + 26 * 3_600_000; ms += 900_000) {
    const p = localParts(ms, timeZone);
    if (p.date === day && p.hour === hour) return ms;
  }
  throw new Error(`No daily slot ${day} ${hour}:00 in ${timeZone}`);
}
