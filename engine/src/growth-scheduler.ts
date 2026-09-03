import type { RunView, VidGenService } from "./service.ts";
import { Scheduler, type JobStatus } from "./scheduler.ts";

type Genre = "moral_story" | "drama" | "true_story" | "short_story";

interface CandidateVariant { family?: string; title?: string }
interface ThumbnailVariant { family?: string; concept?: string }
interface DiscoveryCandidate {
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

export interface GrowthSchedulerHandle {
  status(): JobStatus[];
  runNow(id: string): Promise<void>;
  stop(): void;
}

const POLL_MS = 3000;
const MAX_WAIT_MS = 90 * 60_000;

/**
 * startRun currently accepts a plain intent brief. Until package_seed is
 * threaded into VidGenService's stable public RunOptions in a follow-up schema
 * plumbing pass, preserve the discovery tournament winner losslessly inside
 * that brief. growth_packager@1 recognizes this explicit envelope and treats it
 * as authoritative seed data rather than starting from a bare topic.
 *
 * This is intentionally machine-readable and bounded under intent.brief's 2k
 * limit. The human-facing brief stays first so old logs/UI remain readable.
 */
export function briefWithPackageSeed(candidate: DiscoveryCandidate): string {
  const brief = String(candidate.brief ?? "").trim();
  const seed = {
    angle: candidate.angle ?? "",
    target_audience: candidate.target_audience ?? "",
    curiosity_gap: candidate.curiosity_gap ?? "",
    emotional_engine: candidate.emotional_engine ?? "",
    opening_visual: candidate.opening_visual ?? "",
    opening_line: candidate.opening_line ?? "",
    title_concepts: candidate.title_concepts ?? [],
    thumbnail_concepts: candidate.thumbnail_concepts ?? [],
    scores: candidate.scores ?? {},
    ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
  };
  const envelope = JSON.stringify(seed);
  const room = Math.max(0, 1980 - brief.length - "\nRFC0009_PACKAGE_SEED=".length);
  return `${brief}\nRFC0009_PACKAGE_SEED=${envelope.slice(0, room)}`;
}

function terminal(view: RunView | null): boolean {
  return Boolean(view && view.status !== "running");
}

async function waitForTerminal(service: VidGenService, runId: string): Promise<RunView | null> {
  let stable = 0;
  for (let elapsed = 0; elapsed <= MAX_WAIT_MS; elapsed += POLL_MS) {
    const view = service.getRun(runId);
    if (terminal(view)) {
      stable++;
      // startRun's internal unattended recovery can briefly expose a settled
      // state before it kicks off its next retry. Two stable reads avoids
      // racing that transition, mirroring service.waitForTerminal.
      if (stable >= 2) return view;
    } else {
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return service.getRun(runId);
}

function creativeFailure(view: RunView | null): boolean {
  if (!view) return false;
  return view.status === "blocked" && view.failures.some((f) =>
    f.node_id === "watchability_release" &&
    (/ABANDON_TOPIC|watchability release blocked|REVISE_SCRIPT/i.test(f.error)),
  );
}

function mostRecentProduction(service: VidGenService): number | undefined {
  const recent = service.listRuns()
    .filter((r) => r.kind === "production")
    .map((r) => Date.parse(r.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return recent;
}

/**
 * RFC 0009 unattended orchestration. Discovery returns a ranked 20-30 package
 * tournament; daily production may try several top candidates but advances to
 * the next ONLY when the previous run failed at the creative watchability
 * gate. Infrastructure/QA failures stop the job: changing topic cannot repair
 * a renderer bug, missing credential, or invalid asset.
 */
export function startGrowthScheduler(service: VidGenService): GrowthSchedulerHandle {
  const produceHoursRaw = process.env["SCHEDULE_PRODUCE_HOURS"];
  const produceHours = produceHoursRaw === undefined || produceHoursRaw.trim() === ""
    ? 24
    : Number(produceHoursRaw);
  const produceEnabled = Number.isFinite(produceHours) && produceHours > 0;
  const targetHourRaw = Number(process.env["SCHEDULE_PRODUCE_HOUR_UTC"] ?? 19);
  const targetHourUtc = Number.isFinite(targetHourRaw)
    ? Math.max(0, Math.min(23, Math.floor(targetHourRaw)))
    : 19;
  const measureHours = Number(process.env["SCHEDULE_MEASURE_HOURS"] ?? 24);
  const maxCandidateAttempts = Math.max(1, Math.min(6, Number(process.env["SCHEDULE_MAX_TOPIC_ATTEMPTS"] ?? 3) || 3));
  const analyticsReal = service.capabilities().some((s) => s.id === "analytics" && s.real);

  const scheduler = new Scheduler({
    jobs: [
      {
        id: "produce",
        everyHours: produceHours > 0 ? produceHours : 24,
        enabled: produceEnabled,
        description: `rank packages and publish the first creative winner (up to ${maxCandidateAttempts} topic attempts)`,
        targetHourUtc,
        ...(mostRecentProduction(service) !== undefined ? { seedLastRun: mostRecentProduction(service) } : {}),
        async run() {
          const discovered = await service.discoverTopics();
          const candidates = ((discovered.candidates as { candidates?: DiscoveryCandidate[] })?.candidates ?? [])
            .filter((c) => typeof c.brief === "string" && c.brief.trim().length >= 8)
            .slice(0, maxCandidateAttempts);
          if (candidates.length === 0) throw new Error("discovery returned no production-ready growth packages");

          for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i]!;
            const enrichedBrief = briefWithPackageSeed(candidate);
            console.log(`[growth-scheduler] candidate ${i + 1}/${candidates.length}: ${candidate.brief}`);
            const runId = await service.startRun(enrichedBrief, 180, {
              ...(candidate.genre ? { genre: candidate.genre } : {}),
            });
            const final = await waitForTerminal(service, runId);
            if (final?.status === "completed") {
              console.log(`[growth-scheduler] candidate ${i + 1} cleared creative + technical gates; daily production complete`);
              return;
            }
            if (creativeFailure(final)) {
              console.log(`[growth-scheduler] candidate ${i + 1} failed the creative bar; abandoning it before asset spend and trying the next ranked package`);
              continue;
            }
            throw new Error(
              `candidate ${i + 1} stopped for a non-creative reason; refusing to spend on a different topic: ` +
              `${final?.failures.map((f) => `${f.node_id}: ${f.error}`).join("; ") || final?.status || "unknown"}`,
            );
          }
          throw new Error(`all ${candidates.length} ranked candidates failed the creative bar; no episode published this cycle`);
        },
      },
      {
        id: "measure",
        everyHours: Number.isFinite(measureHours) && measureHours > 0 ? measureHours : 24,
        enabled: analyticsReal && Number.isFinite(measureHours) && measureHours > 0,
        description: "measure public episodes and refresh retention/editorial evidence",
        async run() { await service.measureAll(); },
      },
    ],
  });

  scheduler.start();
  return {
    status: () => scheduler.status(),
    runNow: (id) => scheduler.runNow(id),
    stop: () => scheduler.stop(),
  };
}
