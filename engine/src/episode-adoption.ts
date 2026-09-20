/**
 * Match videos already on the channel to the runs that produced them.
 *
 * Ten episodes were published by hand while the editor-return path was being
 * built. The pipeline holds every artifact for them -- script, package,
 * render -- but no published_episode, so they are invisible to measurement:
 * the measure worker walks published_episode artifacts, finds nothing, and
 * the feedback loop stays empty even though the episodes are live and
 * accumulating views.
 *
 * Adoption closes that gap by writing the missing published_episode. The only
 * hard part is deciding WHICH video belongs to WHICH run, and getting that
 * wrong is worse than leaving the gap open: a mispaired episode attributes
 * real retention to the wrong script prompt, silently and permanently, in the
 * one table that is supposed to settle what works.
 *
 * So this module never guesses. It pairs a run to a video only when the
 * normalised title matches exactly AND that title is unique on both sides.
 * Everything else is reported for a human to resolve -- and that is not a
 * rare path: two of the ten runs carry the identical title "How I Got My Idea
 * Back Without Burning Bridges", which no title-matching scheme can separate.
 */

export interface AdoptableRun {
  run_id: string;
  /** selected_title from the run's growth package. */
  title: string | null;
  created_at?: string | null;
}

export interface ChannelVideo {
  video_id: string;
  title: string;
  published_at?: string | null;
}

export interface AdoptionPair {
  run_id: string;
  video_id: string;
  title: string;
  /** Always "unique_title" today; named so a future rule is distinguishable. */
  matched_on: "unique_title";
}

export interface AdoptionConflict {
  title: string;
  run_ids: string[];
  video_ids: string[];
  reason: string;
}

export interface AdoptionProposal {
  pairs: AdoptionPair[];
  conflicts: AdoptionConflict[];
  unmatched_runs: Array<{ run_id: string; title: string | null }>;
  unmatched_videos: Array<{ video_id: string; title: string }>;
}

/**
 * Titles survive a round trip through YouTube and a human editor, so compare
 * on a normalised form: case, surrounding whitespace, collapsed internal
 * whitespace, and the punctuation most likely to be re-typed differently
 * (curly vs straight quotes, en/em dashes vs hyphens).
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function groupByTitle<T>(items: T[], titleOf: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const raw = titleOf(item);
    if (!raw) continue;
    const key = normaliseTitle(raw);
    if (!key) continue;
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}

/**
 * Propose pairings. Read-only and total: every run and every video appears in
 * exactly one of the four buckets, so nothing can be silently dropped.
 */
export function proposeAdoptions(runs: AdoptableRun[], videos: ChannelVideo[]): AdoptionProposal {
  const runsByTitle = groupByTitle(runs, (r) => r.title);
  const videosByTitle = groupByTitle(videos, (v) => v.title);

  const pairs: AdoptionPair[] = [];
  const conflicts: AdoptionConflict[] = [];
  const pairedRuns = new Set<string>();
  const pairedVideos = new Set<string>();

  for (const [key, matchedRuns] of runsByTitle) {
    const matchedVideos = videosByTitle.get(key);
    if (!matchedVideos || matchedVideos.length === 0) continue;

    if (matchedRuns.length === 1 && matchedVideos.length === 1) {
      const run = matchedRuns[0]!;
      const video = matchedVideos[0]!;
      pairs.push({ run_id: run.run_id, video_id: video.video_id, title: video.title, matched_on: "unique_title" });
      pairedRuns.add(run.run_id);
      pairedVideos.add(video.video_id);
      continue;
    }

    // Ambiguous on one side or both. Reported, never resolved by picking the
    // nearest date or the first item -- a wrong pairing here is unrecoverable
    // once retention starts being attributed to it.
    conflicts.push({
      title: matchedVideos[0]!.title,
      run_ids: matchedRuns.map((r) => r.run_id),
      video_ids: matchedVideos.map((v) => v.video_id),
      reason: matchedRuns.length > 1 && matchedVideos.length > 1
        ? `${matchedRuns.length} runs and ${matchedVideos.length} videos share this title`
        : matchedRuns.length > 1
          ? `${matchedRuns.length} runs share this title, ${matchedVideos.length} video has it`
          : `${matchedVideos.length} videos share this title, ${matchedRuns.length} run has it`,
    });
    for (const run of matchedRuns) pairedRuns.add(run.run_id);
    for (const video of matchedVideos) pairedVideos.add(video.video_id);
  }

  return {
    pairs: pairs.sort((a, b) => a.title.localeCompare(b.title)),
    conflicts: conflicts.sort((a, b) => a.title.localeCompare(b.title)),
    unmatched_runs: runs
      .filter((r) => !pairedRuns.has(r.run_id))
      .map((r) => ({ run_id: r.run_id, title: r.title })),
    unmatched_videos: videos
      .filter((v) => !pairedVideos.has(v.video_id))
      .map((v) => ({ video_id: v.video_id, title: v.title })),
  };
}
