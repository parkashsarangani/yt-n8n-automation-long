import type { RunView, VidGenService } from "./service.ts";
import { Scheduler, type JobStatus } from "./scheduler.ts";

type Genre = "moral_story" | "drama" | "true_story" | "short_story";
interface CandidateVariant { family?: string; title?: string }
interface ThumbnailVariant { family?: string; concept?: string }
export interface DiscoveryCandidate {
  brief?: string;
  genre?: Genre;
  angle?: string;
  target_audience?: string;
  curiosity_gap?: string;
  emotional_engine?: string;
  opening_visual?: string;
  opening_line?: string;
  title_concepts?: CandidateVariant[];
  thumbnail_concepts?: ThumbnailVariant[];
  scores?: { clickability?: number; story_potential?: number; audience_size?: number; overall?: number };
  evidence?: string;
}
export interface GrowthSchedulerHandle { status(): JobStatus[]; runNow(id: string): Promise<void>; stop(): void }
const POLL_MS = 3000;
const MAX_WAIT_MS = 90 * 60_000;
const MIN_COMPONENT_SCORE = 0.55;
const MIN_OVERALL_SCORE = 0.60;

function bounded(value: string | undefined, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Stable machine-readable seed for growth_packager@1.
 * Never truncate serialized JSON: a syntactically broken envelope silently
 * converts a ranked package back into a bare topic. Instead bound each field,
 * then progressively remove lower-priority evidence if the intent.brief limit
 * would still be exceeded.
 */
export function briefWithPackageSeed(candidate: DiscoveryCandidate): string {
  const essential = {
    brief: bounded(candidate.brief, 330),
    ...(candidate.genre ? { genre: candidate.genre } : {}),
    angle: bounded(candidate.angle, 180),
    curiosity_gap: bounded(candidate.curiosity_gap, 150),
    emotional_engine: bounded(candidate.emotional_engine, 130),
    opening_visual: bounded(candidate.opening_visual, 240),
    opening_line: bounded(candidate.opening_line, 170),
    title_concepts: (candidate.title_concepts ?? []).slice(0, 3).map((v) => ({ family: v.family, title: bounded(v.title, 90) })),
    thumbnail_concepts: (candidate.thumbnail_concepts ?? []).slice(0, 3).map((v) => ({ family: v.family, concept: bounded(v.concept, 170) })),
  };
  const richer = {
    ...essential,
    target_audience: bounded(candidate.target_audience, 150),
    ...(candidate.scores ? { scores: candidate.scores } : {}),
    ...(candidate.evidence ? { evidence: bounded(candidate.evidence, 180) } : {}),
  };
  const prefix = "RFC0009_PACKAGE_JSON:";
  const variants: unknown[] = [richer, essential, {
    brief: essential.brief,
    ...(candidate.genre ? { genre: candidate.genre } : {}),
    angle: essential.angle,
    opening_visual: essential.opening_visual,
    opening_line: essential.opening_line,
    title_concepts: essential.title_concepts,
    thumbnail_concepts: essential.thumbnail_concepts,
  }];
  for (const seed of variants) {
    const out = prefix + JSON.stringify(seed);
    if (out.length <= 2000) return out;
  }
  // Last-resort valid JSON remains authoritative and human-readable. Field
  // values are shortened, not the serialized representation itself.
  return prefix + JSON.stringify({
    brief: bounded(candidate.brief, 240),
    ...(candidate.genre ? { genre: candidate.genre } : {}),
    angle: bounded(candidate.angle, 120),
    opening_visual: bounded(candidate.opening_visual, 170),
    opening_line: bounded(candidate.opening_line, 120),
  });
}

export function candidateOverallScore(candidate: DiscoveryCandidate): number {
  const v = candidate.scores?.overall;
  return typeof v === "number" && Number.isFinite(v) ? v : -1;
}

export function viableCandidate(candidate: DiscoveryCandidate): boolean {
  if (typeof candidate.brief !== "string" || candidate.brief.trim().length < 8) return false;
  const s = candidate.scores;
  if (!s) return false;
  const components = [s.clickability, s.story_potential, s.audience_size];
  return components.every((v) => typeof v === "number" && Number.isFinite(v) && v >= MIN_COMPONENT_SCORE)
    && typeof s.overall === "number" && Number.isFinite(s.overall) && s.overall >= MIN_OVERALL_SCORE;
}

function terminal(view: RunView | null): boolean { return Boolean(view && view.status !== "running"); }
async function waitForTerminal(service: VidGenService, runId: string): Promise<RunView | null> {
  let stable = 0;
  for (let elapsed = 0; elapsed <= MAX_WAIT_MS; elapsed += POLL_MS) {
    const view = service.getRun(runId);
    if (terminal(view)) {
      stable++;
      if (stable >= 2) return view;
    } else stable = 0;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return service.getRun(runId);
}
export function creativeFailure(view: RunView | null): boolean {
  return Boolean(view && view.status === "blocked" && view.failures.some((f) =>
    f.node_id === "watchability_release" && /ABANDON_TOPIC|watchability release blocked|REVISE_SCRIPT/i.test(f.error),
  ));
}
function mostRecentProduction(service: VidGenService): number | undefined {
  return service.listRuns().filter((r) => r.kind === "production").map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
}

/** Ranked-candidate unattended orchestration for RFC 0009. */
export function startGrowthScheduler(service: VidGenService): GrowthSchedulerHandle {
  const produceHoursRaw = process.env["SCHEDULE_PRODUCE_HOURS"];
  const produceHours = produceHoursRaw === undefined || produceHoursRaw.trim() === "" ? 24 : Number(produceHoursRaw);
  const produceEnabled = Number.isFinite(produceHours) && produceHours > 0;
  const targetHourRaw = Number(process.env["SCHEDULE_PRODUCE_HOUR_UTC"] ?? 19);
  const targetHourUtc = Number.isFinite(targetHourRaw) ? Math.max(0, Math.min(23, Math.floor(targetHourRaw))) : 19;
  const measureHours = Number(process.env["SCHEDULE_MEASURE_HOURS"] ?? 24);
  const maxCandidateAttempts = Math.max(1, Math.min(6, Number(process.env["SCHEDULE_MAX_TOPIC_ATTEMPTS"] ?? 3) || 3));
  const analyticsReal = service.capabilities().some((s) => s.id === "analytics" && s.real);
  const lastProduction = mostRecentProduction(service);

  const scheduler = new Scheduler({ jobs: [
    {
      id: "produce",
      everyHours: produceHours > 0 ? produceHours : 24,
      enabled: produceEnabled,
      description: `rank packages and publish the first creative winner (up to ${maxCandidateAttempts} topic attempts)`,
      targetHourUtc,
      ...(lastProduction !== undefined ? { seedLastRun: lastProduction } : {}),
      async run() {
        const discovered = await service.discoverTopics();
        const candidates = ((discovered.candidates as { candidates?: DiscoveryCandidate[] })?.candidates ?? [])
          .filter(viableCandidate)
          .sort((a, b) => candidateOverallScore(b) - candidateOverallScore(a))
          .slice(0, maxCandidateAttempts);
        if (candidates.length === 0) throw new Error("discovery returned no growth package above the viability floor");

        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!;
          const enrichedBrief = briefWithPackageSeed(candidate);
          console.log(`[growth-scheduler] candidate ${i + 1}/${candidates.length} score=${candidateOverallScore(candidate).toFixed(3)}: ${candidate.brief}`);
          const runId = await service.startRun(enrichedBrief, 180, { ...(candidate.genre ? { genre: candidate.genre } : {}) });
          const final = await waitForTerminal(service, runId);
          if (final?.status === "completed") {
            console.log(`[growth-scheduler] candidate ${i + 1} cleared creative + technical gates; daily production complete`);
            return;
          }
          if (creativeFailure(final)) {
            console.log(`[growth-scheduler] candidate ${i + 1} failed the creative bar; abandoning before asset spend and trying the next ranked package`);
            continue;
          }
          throw new Error(`candidate ${i + 1} stopped for a non-creative reason; refusing to switch topic: ${final?.failures.map((f) => `${f.node_id}: ${f.error}`).join("; ") || final?.status || "unknown"}`);
        }
        throw new Error(`all ${candidates.length} viable ranked candidates failed the creative bar; no episode published this cycle`);
      },
    },
    {
      id: "measure",
      everyHours: Number.isFinite(measureHours) && measureHours > 0 ? measureHours : 24,
      enabled: analyticsReal && Number.isFinite(measureHours) && measureHours > 0,
      description: "measure public episodes and refresh retention/editorial evidence",
      async run() { await service.measureAll(); },
    },
  ] });
  scheduler.start();
  return { status: () => scheduler.status(), runNow: (id) => scheduler.runNow(id), stop: () => scheduler.stop() };
}
