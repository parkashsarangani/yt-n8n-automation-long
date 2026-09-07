/**
 * Pexels stock-video candidate provider for RFC 0010.
 *
 * This provider deliberately returns several source candidates and their raw
 * bytes; it does NOT decide which clip is semantically correct. Frame sampling,
 * segment scoring, and admission happen in the visual worker/VLM gate.
 */

import { ProviderError } from "../provider.ts";

export interface StockVideoCandidate {
  provider: "pexels";
  id: string;
  source_url: string;
  photographer: string;
  duration_sec: number;
  width: number;
  height: number;
  bytes: Uint8Array;
  media_type: "video/mp4";
}

export interface PexelsVideoOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface PexelsVideoFile {
  id?: number;
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  link?: string;
}

interface PexelsVideo {
  id?: number;
  width?: number;
  height?: number;
  url?: string;
  duration?: number;
  user?: { name?: string };
  video_files?: PexelsVideoFile[];
}

interface PexelsSearchResponse {
  videos?: PexelsVideo[];
}

function landscapeScore(file: PexelsVideoFile): number {
  if (file.file_type !== "video/mp4" || !file.link) return -1;
  const width = file.width ?? 0;
  const height = file.height ?? 0;
  if (width <= 0 || height <= 0 || width < height) return -1;
  const sizePenalty = Math.abs(width - 1920) / 1920;
  const aspectPenalty = Math.abs(width / height - 16 / 9);
  const qualityBonus = file.quality === "hd" ? 2 : 0;
  return qualityBonus + Math.min(width, 1920) / 1920 - sizePenalty * 0.25 - aspectPenalty;
}

function bestFile(video: PexelsVideo): PexelsVideoFile | undefined {
  return [...(video.video_files ?? [])]
    .filter((file) => landscapeScore(file) >= 0)
    .sort((a, b) => landscapeScore(b) - landscapeScore(a))[0];
}

export class PexelsVideoProvider {
  readonly id = "pexels/video";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  private readonly timeoutMs: number;

  constructor(opts: PexelsVideoOptions = {}) {
    const key = opts.apiKey ?? process.env["PEXELS_API_KEY"];
    if (!key?.trim()) throw new ProviderError("PexelsVideoProvider needs PEXELS_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = (opts.baseUrl ?? "https://api.pexels.com/v1/videos").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const raw = Number(process.env["PEXELS_TIMEOUT_MS"]);
    this.timeoutMs = Number.isFinite(raw) && raw >= 5_000 ? raw : 90_000;
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...(init ?? {}), signal: controller.signal });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new ProviderError(aborted ? `Pexels request timed out after ${this.timeoutMs}ms` : `Pexels request failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, limit = 5): Promise<StockVideoCandidate[]> {
    const clean = query.trim();
    if (!clean) return [];
    const wanted = Math.max(1, Math.min(5, limit));
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("query", clean);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("size", "medium");
    // Fetch extra metadata candidates because some entries lack a suitable MP4.
    url.searchParams.set("per_page", String(Math.max(10, wanted * 2)));

    const res = await this.fetchWithTimeout(url.toString(), {
      headers: { Authorization: this.apiKey },
    });
    if (!res.ok) {
      throw new ProviderError(`Pexels video search returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json() as PexelsSearchResponse;
    const selected = (body.videos ?? [])
      .map((video) => ({ video, file: bestFile(video) }))
      .filter((entry): entry is { video: PexelsVideo; file: PexelsVideoFile & { link: string } } => Boolean(entry.file?.link))
      .slice(0, wanted);

    const candidates: StockVideoCandidate[] = [];
    for (const { video, file } of selected) {
      const dl = await this.fetchWithTimeout(file.link);
      if (!dl.ok) continue;
      const bytes = new Uint8Array(await dl.arrayBuffer());
      if (bytes.length === 0) continue;
      candidates.push({
        provider: "pexels",
        id: String(video.id ?? file.id ?? candidates.length),
        source_url: video.url ?? file.link,
        photographer: video.user?.name ?? "Unknown",
        duration_sec: Math.max(0, Number(video.duration ?? 0)),
        width: Number(file.width ?? video.width ?? 0),
        height: Number(file.height ?? video.height ?? 0),
        bytes,
        media_type: "video/mp4",
      });
    }
    return candidates;
  }
}
