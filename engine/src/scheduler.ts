/**
 * Recurring jobs.
 *
 * Deliberately small: an interval check, not a cron implementation. Nothing
 * here needs "the second Tuesday of the month" — it needs "measure once a day
 * and do not pile up".
 *
 * Two rules shape the design:
 *
 * 1. **Overlap is refused, not queued.** A measurement pass can take minutes
 *    and a production run takes hours. Starting a second while the first is
 *    running would double-spend and interleave writes, so a job that is still
 *    going simply skips its turn.
 *
 * 2. **A failing job must not stop the schedule.** One bad pass is a bad pass;
 *    it is recorded on the job and the next tick proceeds. A scheduler that
 *    dies on the first error is worse than no scheduler, because it looks like
 *    it is still working.
 *
 * Last-run state is held in memory, not in a dedicated store -- but a bare
 * restart must not make every job immediately due again. That was harmless
 * while production was gated behind an explicit opt-in (nobody restarts a
 * dev box mid-shift), but it is not harmless once production defaults to
 * enabled and deploys happen several times a day: each deploy would fire a
 * brand new public episode regardless of when the last one actually ran.
 * `seedLastRun` on a Job lets the caller derive a real last-run time from
 * persisted history (e.g. the most recent production run) instead of `null`.
 */

export interface Job {
  id: string;
  /** How often to run. Ignored when targetHourUtc is set (see below). */
  everyHours: number;
  /** Off jobs are listed but never fire — visible rather than absent. */
  enabled: boolean;
  /** One-line description for the status view. */
  description: string;
  /**
   * Epoch ms of this job's last real completion, if the caller can derive one
   * from persisted state. Absent/undefined means "unknown, treat as due" --
   * the old behavior, still correct for a job with no independent record of
   * its own past runs.
   */
  seedLastRun?: number;
  /**
   * Pin this job to a specific UTC hour (0-23) once a day, instead of "every
   * everyHours since it last finished". A pure interval drifts with however
   * long the job itself took (a 2-hour production run pushes the next day's
   * slot two hours later, and so on) and carries no notion of *when in the
   * day* is a good time to publish -- for a channel targeting a US audience,
   * that's early-mid afternoon US Eastern, not "whenever the last run
   * happened to finish". No DST correction: one fixed UTC hour, which drifts
   * an hour relative to US local time twice a year -- deliberately simple
   * over exactly right, revisit if that turns out to matter.
   */
  targetHourUtc?: number;
  run(): Promise<void>;
}

export interface JobStatus {
  id: string;
  description: string;
  enabled: boolean;
  every_hours: number;
  running: boolean;
  last_run: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  next_run: string | null;
  runs: number;
}

interface JobState {
  lastRun: number | null;
  running: boolean;
  lastError: string | null;
  lastDurationMs: number | null;
  runs: number;
}

export interface SchedulerOptions {
  jobs: Job[];
  /** How often to check whether anything is due. */
  tickMs?: number;
  now?: () => number;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isSameUtcDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate();
}

/** The next epoch ms at which `job` becomes due, given its last completion (or null). */
function nextRunAt(job: Job, lastRun: number | null, nowMs: number): number {
  if (job.targetHourUtc === undefined) {
    return lastRun === null ? nowMs : lastRun + job.everyHours * HOUR_MS;
  }
  // Already ran today -> tomorrow's slot. Otherwise today's slot, whether
  // that's still ahead of now or already passed (in which case it's due now).
  const anchor = lastRun !== null && isSameUtcDay(lastRun, nowMs) ? nowMs + DAY_MS : nowMs;
  const slot = new Date(anchor);
  slot.setUTCHours(job.targetHourUtc, 0, 0, 0);
  return slot.getTime();
}

function isDue(job: Job, lastRun: number | null, nowMs: number): boolean {
  return nowMs >= nextRunAt(job, lastRun, nowMs);
}

export class Scheduler {
  private readonly jobs: Job[];
  private readonly state = new Map<string, JobState>();
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SchedulerOptions) {
    this.jobs = opts.jobs;
    this.tickMs = opts.tickMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? console;
    for (const j of this.jobs) {
      this.state.set(j.id, {
        lastRun: j.seedLastRun ?? null,
        running: false,
        lastError: null,
        lastDurationMs: null,
        runs: 0,
      });
    }
  }

  start(): void {
    if (this.timer) return;
    // unref so the scheduler never keeps the process alive on its own.
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();

    const on = this.jobs.filter((j) => j.enabled);
    this.logger.log(
      on.length === 0
        ? "[scheduler] no jobs enabled"
        : `[scheduler] ${on.map((j) => `${j.id} every ${j.everyHours}h`).join(", ")}`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Public so tests can drive it without waiting on wall-clock time. */
  async tick(): Promise<void> {
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      const st = this.state.get(job.id)!;
      if (st.running) continue;
      if (!isDue(job, st.lastRun, this.now())) continue;
      await this.execute(job);
    }
  }

  /** Run a job immediately, ignoring its schedule. Overlap is still refused. */
  async runNow(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`unknown job: ${id}`);
    if (this.state.get(id)!.running) throw new Error(`${id} is already running`);
    await this.execute(job);
  }

  private async execute(job: Job): Promise<void> {
    const st = this.state.get(job.id)!;
    st.running = true;
    const started = this.now();
    try {
      await job.run();
      st.lastError = null;
    } catch (err) {
      // Recorded, never rethrown: one bad pass must not take down the schedule.
      st.lastError = err instanceof Error ? err.message : String(err);
      this.logger.error(`[scheduler] ${job.id} failed: ${st.lastError}`);
    } finally {
      st.running = false;
      // Stamped on completion rather than on start, so a job that takes longer
      // than its own interval does not immediately become due again.
      st.lastRun = this.now();
      st.lastDurationMs = st.lastRun - started;
      st.runs += 1;
    }
  }

  status(): JobStatus[] {
    return this.jobs.map((j) => {
      const st = this.state.get(j.id)!;
      return {
        id: j.id,
        description: j.description,
        enabled: j.enabled,
        every_hours: j.everyHours,
        running: st.running,
        last_run: st.lastRun === null ? null : new Date(st.lastRun).toISOString(),
        last_error: st.lastError,
        last_duration_ms: st.lastDurationMs,
        next_run:
          !j.enabled || (st.lastRun === null && j.targetHourUtc === undefined)
            ? null
            : new Date(nextRunAt(j, st.lastRun, this.now())).toISOString(),
        runs: st.runs,
      };
    });
  }
}
