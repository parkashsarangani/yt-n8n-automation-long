// Resolves a real, topic-relevant icon for a diagram entity via Iconify's
// public search API (https://iconify.design), instead of the arbitrary
// hash-picked geometric shape MOTION_ENTITY_SHAPES assigns in
// motion-visual-identity.ts. That hash contract stays exactly as-is (it also
// keeps AI-generated imagery's shape/color prompts consistent with motion
// graphics across a cut -- see the comment on motionEntityVisualTokens) --
// this module only supplies an ADDITIONAL, optional icon that the Remotion
// renderer prefers when present, falling back to the existing shape
// otherwise. Iconify aggregates 300k+ icons from 200+ open-source icon sets
// (MIT/Apache/similar) behind one free public search endpoint, so this needs
// no curated asset library, no embedding model, and no vector database --
// the search ranking is Iconify's, not ours.
//
// Every failure mode here (network error, timeout, no results, oversized
// payload) resolves to `null`, never a thrown error: a missing icon must
// degrade to the existing shape, not fail episode generation. This runs
// once per unique entity label per run (callers should cache), not per
// frame -- Remotion never makes network calls of its own.

const SEARCH_TIMEOUT_MS = 4000;
const DATA_TIMEOUT_MS = 4000;
// Iconify icon bodies are typically a few hundred bytes of path data. A
// multi-kilobyte body is almost always a decorative/detailed icon that will
// render illegibly at the ~20-45px EntityMark size, so reject it and fall
// back rather than embed something that won't read as anything at that
// scale -- the same "graceful, not broken" principle as a failed search.
const MAX_ICON_BODY_LENGTH = 2000;

export interface ResolvedIcon {
  iconId: string; // "prefix:name", kept for logging/debugging only
  viewBox: string;
  body: string;
}

interface IconifySearchResponse {
  icons?: unknown;
}

interface IconifyDataResponse {
  width?: unknown;
  height?: unknown;
  icons?: unknown;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Iconify icon bodies are sourced from vetted open-source icon sets, not
// arbitrary user content, but this is still third-party network response
// data landing in a rendered video -- strip anything that could execute
// rather than trust the source implicitly. `body` is later injected into an
// SVG <g> as raw markup (see MotionDesignSystem.tsx EntityMark), so this is
// the one real defense-in-depth point.
function sanitizeSvgBody(body: string): string | null {
  const lower = body.toLowerCase();
  if (lower.includes("<script") || lower.includes("javascript:") || /\son\w+\s*=/.test(lower)) return null;
  return body;
}

/**
 * Search Iconify for the best icon match for a diagram entity's label (e.g.
 * "water molecule", "onion", "traffic route") and fetch its SVG body.
 * Returns null on any failure -- callers must treat that as "no icon
 * available", not an error.
 */
export async function searchEntityIcon(label: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ResolvedIcon | null> {
  const query = label.trim();
  if (!query) return null;
  try {
    const iconId = await withTimeout(SEARCH_TIMEOUT_MS, async (signal) => {
      const res = await fetchImpl(`https://api.iconify.design/search?query=${encodeURIComponent(query)}&limit=5`, { signal });
      if (!res.ok) return null;
      const data = (await res.json()) as IconifySearchResponse;
      const icons = Array.isArray(data.icons) ? data.icons.filter((value): value is string => typeof value === "string") : [];
      return icons[0] ?? null;
    });
    if (!iconId) return null;

    const sepIndex = iconId.indexOf(":");
    if (sepIndex <= 0) return null;
    const prefix = iconId.slice(0, sepIndex);
    const name = iconId.slice(sepIndex + 1);
    if (!/^[a-z0-9-]+$/.test(prefix) || !/^[a-z0-9-]+$/.test(name)) return null; // defensive: only expect this shape from Iconify's own results

    return await withTimeout(DATA_TIMEOUT_MS, async (signal) => {
      const res = await fetchImpl(`https://api.iconify.design/${prefix}.json?icons=${encodeURIComponent(name)}`, { signal });
      if (!res.ok) return null;
      const data = (await res.json()) as IconifyDataResponse;
      const iconsRecord = data.icons && typeof data.icons === "object" ? data.icons as Record<string, unknown> : {};
      const entry = iconsRecord[name] as Record<string, unknown> | undefined;
      const rawBody = entry && typeof entry.body === "string" ? entry.body : null;
      if (!rawBody || rawBody.length > MAX_ICON_BODY_LENGTH) return null;
      const body = sanitizeSvgBody(rawBody);
      if (!body) return null;
      const width = typeof entry?.width === "number" ? entry.width : (typeof data.width === "number" ? data.width : 24);
      const height = typeof entry?.height === "number" ? entry.height : (typeof data.height === "number" ? data.height : 24);
      return { iconId, viewBox: `0 0 ${width} ${height}`, body };
    });
  } catch {
    // Network error, timeout (AbortError), or malformed JSON -- all the same
    // outcome: no icon this time, render the existing shape instead.
    return null;
  }
}

/**
 * Resolves icons for a batch of (identityKey, label) pairs, deduped by label
 * so an entity repeated across scenes (e.g. "water molecule" in 6 of an
 * episode's 17 scenes) is only looked up once per run. Lookups run
 * concurrently; a failure for one entity never blocks the others.
 */
export async function resolveEntityIcons(
  entries: Array<{ id: string; label: string }>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Map<string, ResolvedIcon>> {
  const byLabel = new Map<string, string[]>(); // label -> ids sharing it
  for (const { id, label } of entries) {
    const key = label.trim().toLowerCase();
    if (!key) continue;
    const ids = byLabel.get(key) ?? [];
    ids.push(id);
    byLabel.set(key, ids);
  }
  const labels = [...byLabel.keys()];
  const results = await Promise.all(labels.map((label) => searchEntityIcon(label, fetchImpl)));
  const out = new Map<string, ResolvedIcon>();
  labels.forEach((label, i) => {
    const icon = results[i];
    if (!icon) return;
    for (const id of byLabel.get(label) ?? []) out.set(id, icon);
  });
  return out;
}
