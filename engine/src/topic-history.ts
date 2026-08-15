/**
 * Builds the topic_history input artifact.
 *
 * In the service layer for the same reason as performance-window: it is a query
 * across the whole store plus a lineage walk, which is exactly what a worker may
 * not do (RFC 0003). Seeded as a graph input like intent.
 *
 * Covers every story ever written, not only published ones. A topic that was
 * drafted and abandoned is still spent ground — proposing it again wastes a run
 * and, worse, looks to the operator like the system has no memory.
 */

import type { Artifact } from "./artifact.ts";
import type { ArtifactStore } from "./store.ts";

export interface HistoryTopic {
  topic: string;
  title?: string;
  created_at?: string;
  published?: boolean;
  views?: number | null;
  average_view_percentage?: number | null;
}

export interface TopicHistory {
  generated_at: string;
  count: number;
  topics: HistoryTopic[];
}

export async function buildTopicHistory(
  store: ArtifactStore,
  opts: { now?: () => Date; max?: number; exclude?: Set<string> } = {},
): Promise<TopicHistory> {
  const now = opts.now ?? (() => new Date());
  const max = opts.max ?? 300;
  const exclude = opts.exclude ?? new Set<string>();

  const index = await store.index();

  // Performance keyed by video id, so a covered topic can carry how it did.
  const perfByVideo = new Map<string, { views: number; retention: number | null }>();
  for (const row of index.filter((r) => r.schema_id === "episode_performance")) {
    const a = await store.get(row.artifact_id);
    if (!a) continue;
    const p = a.payload as {
      external_id?: string;
      metrics?: { views?: number; average_view_percentage?: number | null };
    };
    if (!p.external_id || exclude.has(p.external_id)) continue;
    perfByVideo.set(p.external_id, {
      views: p.metrics?.views ?? 0,
      retention: p.metrics?.average_view_percentage ?? null,
    });
  }

  // Which stories reached a published episode, and under which video id.
  const publishedVideoByStory = new Map<string, string>();
  for (const row of index.filter((r) => r.schema_id === "published_episode")) {
    const a = await store.get(row.artifact_id);
    if (!a) continue;
    const externalId = (a.payload as { external_id?: string }).external_id;
    if (!externalId) continue;
    let ancestors: Artifact[];
    try {
      ancestors = await store.lineage(a.artifact_id);
    } catch {
      continue;
    }
    for (const anc of ancestors) {
      if (anc.schema_id === "story") publishedVideoByStory.set(anc.artifact_id, externalId);
    }
  }

  const topics: HistoryTopic[] = [];
  const seen = new Set<string>();

  for (const row of index.filter((r) => r.schema_id === "story")) {
    const a = await store.get(row.artifact_id);
    if (!a) continue;
    const p = a.payload as { topic?: string; title?: string };
    if (!p.topic) continue;

    // Identical stories dedup to one artifact anyway, but a re-run with a
    // reworded topic would otherwise appear twice and inflate the history.
    const key = p.topic.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const videoId = publishedVideoByStory.get(a.artifact_id);
    const perf = videoId ? perfByVideo.get(videoId) : undefined;

    topics.push({
      topic: p.topic,
      ...(p.title ? { title: p.title } : {}),
      created_at: row.created_at,
      published: Boolean(videoId),
      ...(perf ? { views: perf.views, average_view_percentage: perf.retention } : {}),
    });
  }

  // Newest first, then truncate: recent ground is the ground most worth avoiding.
  topics.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const kept = topics.slice(0, max);

  return { generated_at: now().toISOString(), count: kept.length, topics: kept };
}
