import type { RunView, VidGenService } from "./service.ts";
import { Scheduler, type JobStatus } from "./scheduler.ts";
import { MAX_ATTEMPTS_BEFORE_ACCEPTING } from "./workers/watchability-release.ts";
import { localHourToUtcHour } from "./timezone-hour.ts";

/**
 * SCHEDULE_PRODUCE_HOUR_UTC, when set, is a literal UTC hour override.
 * Otherwise resolve today's UTC hour from a local wall-clock target (default
 * 9pm Europe/Berlin) so the daily publish slot survives a DST change instead
 * of silently drifting an hour twice a year -- this recomputes fresh on
 * every service start, and the project redeploys on every merge to main, so
 * restart-driven staleness is not a real risk here.
 */
function produceTargetHourUtc(): number {
  const explicit = process.env["SCHEDULE_PRODUCE_HOUR_UTC"]?.trim();
  if (explicit) {
    const n = Number(explicit);
    return Number.isFinite(n) ? Math.max(0, Math.min(23, Math.floor(n))) : 19;
  }
  const timeZone = process.env["SCHEDULE_PRODUCE_TIMEZONE"]?.trim() || "Europe/Berlin";
  const localHourRaw = Number(process.env["SCHEDULE_PRODUCE_LOCAL_HOUR"] ?? 21);
  const localHour = Number.isInteger(localHourRaw) && localHourRaw >= 0 && localHourRaw <= 23 ? localHourRaw : 21;
  try {
    return localHourToUtcHour(timeZone, localHour);
  } catch {
    console.warn(`[scheduler] SCHEDULE_PRODUCE_TIMEZONE "${timeZone}" is not a recognized IANA zone; falling back to 19:00 UTC`);
    return 19;
  }
}

type Genre = "moral_story" | "drama" | "true_story" | "short_story";
interface CandidateVariant { family?: string; title?: string }
interface ThumbnailVariant { family?: string; concept?: string }
export interface DiscoveryCandidate {
  brief?: string; genre?: Genre; angle?: string; target_audience?: string; curiosity_gap?: string; emotional_engine?: string;
  opening_visual?: string; opening_line?: string; title_concepts?: CandidateVariant[]; thumbnail_concepts?: ThumbnailVariant[];
  scores?: { clickability?: number; story_potential?: number; audience_size?: number; overall?: number }; evidence?: string;
}
/**
 * Mirrors intent@1.3.0 `package_seed` exactly. Kept as one exported type so
 * the scheduler, the service and the schema cannot drift apart silently.
 */
export interface PackageSeed {
  angle: string; target_audience: string; curiosity_gap: string; emotional_engine: string;
  opening_visual: string; opening_line: string;
  title_concepts: Array<{ family: string; title: string }>;
  thumbnail_concepts: Array<{ family: string; concept: string }>;
  scores: { clickability?: number; story_potential?: number; audience_size?: number; overall?: number };
}

export type CreativeFailureKind = "creative_viability" | "watchability";
export type WatchabilityRetryState = "retrying" | "exhausted";
export interface GrowthSchedulerHandle { status(): JobStatus[]; runNow(id: string): Promise<void>; stop(): void }
export interface GrowthSchedulerOptions {
  /** Test/embedding override only; production defaults to a three-second observation cadence. */
  pollMs?: number;
  /** Test/embedding override only; production allows long image/render stages up to 90 minutes. */
  maxWaitMs?: number;
}
const POLL_MS = 3000, MAX_WAIT_MS = 90 * 60_000, MIN_COMPONENT_SCORE = 0.55, MIN_OVERALL_SCORE = 0.60;
function bounded(value: string | undefined, max: number): string { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }

/**
 * The tournament winner, as typed data for `intent.package_seed`.
 *
 * This used to be a JSON blob prefixed onto the brief string. Two things were
 * wrong with that: the marker the scheduler wrote (`RFC0009_PACKAGE_JSON:`)
 * never matched the one the prompt read (`RFC0009_PACKAGE_SEED=`), and the
 * brief carried no human-facing prose before the marker for the packager to
 * take `premise` from. So the authoritative selection RFC 0009 decision 1 is
 * built on was, in practice, discarded -- the packager saw an unparseable
 * brief and reinvented the proposition. A typed field cannot drift like that:
 * the schema either accepts it or the run fails loudly.
 */
export function packageSeedOf(candidate: DiscoveryCandidate): PackageSeed | undefined {
  const seed = {
    angle: bounded(candidate.angle, 300),
    target_audience: bounded(candidate.target_audience, 220),
    curiosity_gap: bounded(candidate.curiosity_gap, 220),
    emotional_engine: bounded(candidate.emotional_engine, 180),
    opening_visual: bounded(candidate.opening_visual, 300),
    opening_line: bounded(candidate.opening_line, 220),
    title_concepts: (candidate.title_concepts ?? []).slice(0, 3).map((v) => ({ family: v.family!, title: bounded(v.title, 90) })),
    thumbnail_concepts: (candidate.thumbnail_concepts ?? []).slice(0, 3).map((v) => ({ family: v.family!, concept: bounded(v.concept, 170) })),
    scores: candidate.scores!,
  };
  // intent@1.3.0 requires every one of these. A partial candidate is passed
  // through as a plain brief rather than failing the run: manual/UI briefs
  // legitimately have no tournament behind them.
  const complete = seed.angle && seed.target_audience && seed.curiosity_gap && seed.emotional_engine
    && seed.opening_visual && seed.opening_line
    && seed.title_concepts.length === 3 && seed.title_concepts.every((v) => v.family && v.title)
    && seed.thumbnail_concepts.length === 3 && seed.thumbnail_concepts.every((v) => v.family && v.concept)
    && candidate.scores !== undefined;
  return complete ? seed : undefined;
}
export function candidateOverallScore(candidate: DiscoveryCandidate): number { const v = candidate.scores?.overall; return typeof v === "number" && Number.isFinite(v) ? v : -1; }
export function viableCandidate(candidate: DiscoveryCandidate): boolean {
  if (typeof candidate.brief !== "string" || candidate.brief.trim().length < 8) return false;
  const s = candidate.scores; if (!s) return false;
  return [s.clickability, s.story_potential, s.audience_size].every((v) => typeof v === "number" && Number.isFinite(v) && v >= MIN_COMPONENT_SCORE)
    && typeof s.overall === "number" && Number.isFinite(s.overall) && s.overall >= MIN_OVERALL_SCORE;
}

/**
 * A watchability worker failure is not automatically a terminal topic failure.
 * `VidGenService.startRun()` deliberately parks between each unattended script
 * regeneration, so the scheduler can observe a transient `blocked` status
 * while the same run is still about to retry. Advancing the tournament from
 * one of those intermediate states can launch candidate N+1 while candidate N
 * is still self-healing.
 *
 * The release worker includes the real evaluation number in creative failures.
 * Only the bounded final evaluation is terminal for scheduler failover. A
 * PACKAGE_CONTRACT (or any other watchability_release implementation failure)
 * is deliberately excluded: changing topic must never hide a structural bug.
 */
export function watchabilityRetryState(view: RunView | null): WatchabilityRetryState | null {
  if (!view || view.status !== "blocked") return null;
  const creativeFailures = view.failures.filter((f) =>
    f.node_id === "watchability_release" && /\((?:ABANDON_TOPIC|REVISE_SCRIPT)\b/i.test(f.error),
  );
  if (!creativeFailures.length) return null;

  let highestAttempt: number | null = null;
  for (const failure of creativeFailures) {
    const match = /\battempt\s+(\d+)\b/i.exec(failure.error);
    if (!match) continue;
    const attempt = Number(match[1]);
    if (Number.isInteger(attempt) && attempt > 0) highestAttempt = Math.max(highestAttempt ?? 0, attempt);
  }
  // Older persisted creative failures may predate the explicit attempt marker.
  // They are already terminal records, so preserve historical failover rather
  // than waiting forever for retry metadata that can never appear.
  if (highestAttempt === null) return "exhausted";
  return highestAttempt >= MAX_ATTEMPTS_BEFORE_ACCEPTING ? "exhausted" : "retrying";
}

function terminal(view: RunView | null): boolean { return Boolean(view && view.status !== "running"); }
async function waitForTerminal(service: VidGenService, runId: string, opts: GrowthSchedulerOptions = {}): Promise<RunView | null> {
  const pollMs = Math.max(1, Math.floor(opts.pollMs ?? POLL_MS));
  const maxWaitMs = Math.max(pollMs, Math.floor(opts.maxWaitMs ?? MAX_WAIT_MS));
  let stable = 0;
  for (let elapsed = 0; elapsed <= maxWaitMs; elapsed += pollMs) {
    const view = service.getRun(runId);
    // A blocked attempts 1..N-1 watchability result is an intermediate state
    // owned by driveUnattended(), not a scheduler terminal. Never count it as
    // stable even if regeneration/persistence takes longer than two polls.
    if (watchabilityRetryState(view) === "retrying") {
      stable = 0;
    } else if (terminal(view)) {
      stable++;
      if (stable >= 2) return view;
    } else {
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return service.getRun(runId);
}

/**
 * Only creative-stage terminal states authorize switching topics. Keep the
 * reason explicit because creative_viability is initially a WAITING gate and
 * must be terminally abandoned before advancing, while watchability is already
 * blocked after the service's bounded script retries are exhausted.
 */
export function creativeFailureKind(view: RunView | null): CreativeFailureKind | null {
  if (!view) return null;
  if (view.status === "waiting" && view.waiting.some((w) => w.node_id === "creative_viability")) return "creative_viability";
  if (watchabilityRetryState(view) === "exhausted") return "watchability";
  return null;
}

export function creativeFailure(view: RunView | null): boolean {
  return creativeFailureKind(view) !== null;
}

function mostRecentProduction(service: VidGenService): number | undefined {
  return service.listRuns().filter((r) => r.kind === "production").map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
}

export function startGrowthScheduler(service: VidGenService, opts: GrowthSchedulerOptions = {}): GrowthSchedulerHandle {
  const raw = process.env["SCHEDULE_PRODUCE_HOURS"];
  const produceHours = raw === undefined || raw.trim() === "" ? 24 : Number(raw);
  const targetHourUtc = produceTargetHourUtc();
  const measureHours = Number(process.env["SCHEDULE_MEASURE_HOURS"] ?? 24);
  const maxCandidateAttempts = Math.max(1, Math.min(6, Number(process.env["SCHEDULE_MAX_TOPIC_ATTEMPTS"] ?? 3) || 3));
  const analyticsReal = service.capabilities().some((s) => s.id === "analytics" && s.real);
  const lastProduction = mostRecentProduction(service);
  const scheduler = new Scheduler({ jobs: [
    {
      id: "produce", everyHours: produceHours > 0 ? produceHours : 24, enabled: Number.isFinite(produceHours) && produceHours > 0,
      description: `rank packages and publish the first creative winner (up to ${maxCandidateAttempts} topic attempts), targeting 9pm ${process.env["SCHEDULE_PRODUCE_TIMEZONE"]?.trim() || "Europe/Berlin"} (currently ${targetHourUtc}:00 UTC)`, targetHourUtc,
      ...(lastProduction !== undefined ? { seedLastRun: lastProduction } : {}),
      async run() {
        const discovered = await service.discoverTopics();
        const candidates = ((discovered.candidates as { candidates?: DiscoveryCandidate[] })?.candidates ?? [])
          .filter(viableCandidate)
          .sort((a, b) => candidateOverallScore(b) - candidateOverallScore(a))
          .slice(0, maxCandidateAttempts);
        if (!candidates.length) throw new Error("discovery returned no growth package above the viability floor");

        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!;
          console.log(`[growth-scheduler] candidate ${i + 1}/${candidates.length} score=${candidateOverallScore(candidate).toFixed(3)}: ${candidate.brief}`);
          const seed = packageSeedOf(candidate);
          const runId = await service.startRun(candidate.brief!, 180, {
            ...(candidate.genre ? { genre: candidate.genre } : {}),
            ...(seed ? { packageSeed: seed } : {}),
          });
          const final = await waitForTerminal(service, runId, opts);
          if (final?.status === "completed") {
            console.log(`[growth-scheduler] candidate ${i + 1} cleared creative + technical gates; daily production complete`);
            return;
          }

          const failure = creativeFailureKind(final);
          if (failure === "creative_viability") {
            const wait = final?.waiting.find((w) => w.node_id === "creative_viability");
            const reason = wait?.reason ?? "creative viability critic recommended abandoning this topic";
            // A normal reject means "regenerate the upstream artifact" in the
            // executor. That is the opposite of RFC 0009 decision 7. Use the
            // explicit terminal decision, then verify it actually settled as a
            // persisted blocked gate before another topic is allowed to start.
            await service.decide(runId, "creative_viability", { result: "abandon", reason });
            const abandoned = await waitForTerminal(service, runId, opts);
            const settled = abandoned?.status === "blocked" && abandoned.failures.some((f) =>
              f.node_id === "creative_viability" && /abandoned:/i.test(f.error),
            );
            if (!settled) {
              throw new Error(`candidate ${i + 1} was selected for abandonment but the creative_viability gate did not terminate cleanly`);
            }
            console.log(`[growth-scheduler] candidate ${i + 1} abandoned before asset spend; trying the next ranked package`);
            continue;
          }
          if (failure === "watchability") {
            console.log(`[growth-scheduler] candidate ${i + 1} exhausted the bounded script search before asset spend; trying the next ranked package`);
            continue;
          }

          throw new Error(`candidate ${i + 1} stopped for a non-creative reason; refusing to switch topic: ${final?.failures.map((f) => `${f.node_id}: ${f.error}`).join("; ") || final?.status || "unknown"}`);
        }
        throw new Error(`all ${candidates.length} viable ranked candidates failed the creative bar; no episode published this cycle`);
      },
    },
    { id: "measure", everyHours: Number.isFinite(measureHours) && measureHours > 0 ? measureHours : 24, enabled: analyticsReal && Number.isFinite(measureHours) && measureHours > 0, description: "measure public episodes and refresh retention/editorial evidence", async run() {
      const result = await service.measureAll();
      if (result.failed.length) throw new Error(`Measurement failed for ${result.failed.length} episode(s): ${result.failed[0]!.error}`);
    } },
  ] });
  scheduler.start();
  return { status: () => scheduler.status(), runNow: (id) => scheduler.runNow(id), stop: () => scheduler.stop() };
}
