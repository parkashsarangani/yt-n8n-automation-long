/**
 * Stock image provider — Pexels, Unsplash, Pixabay.
 *
 * Tries free stock sources in priority order. Zero cost per image.
 * Replaces Fal AI for image generation entirely.
 *
 * Search strategy:
 * 1. Try the full combined search terms (most specific)
 * 2. If no results, try each term individually (broader)
 * 3. Falls through each source: Pexels → Unsplash → Pixabay
 */

import { ProviderError, type Aspect, type ImageProvider, type Usage } from "../provider.ts";

const ORIENTATIONS: Record<Aspect, string> = {
    "16:9": "landscape",
    "9:16": "portrait",
    "1:1": "square",
};

export interface StockImageOptions {
    pexelsKey?: string;
    unsplashKey?: string;
    pixabayKey?: string;
    fetchImpl?: typeof fetch;
}

export class StockImageProvider implements ImageProvider {
    readonly id = "stock/pexels+unsplash+pixabay";
    private readonly pexelsKey: string | undefined;
    private readonly unsplashKey: string | undefined;
    private readonly pixabayKey: string | undefined;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: StockImageOptions = {}) {
        this.pexelsKey = opts.pexelsKey ?? process.env["PEXELS_API_KEY"];
        this.unsplashKey = opts.unsplashKey ?? process.env["UNSPLASH_ACCESS_KEY"];
        this.pixabayKey = opts.pixabayKey ?? process.env["PIXABAY_API_KEY"];
        this.fetchImpl = opts.fetchImpl ?? fetch;

        if (!this.pexelsKey && !this.unsplashKey) {
            throw new ProviderError("StockImageProvider needs at least PEXELS_API_KEY or UNSPLASH_ACCESS_KEY");
        }
    }

    async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
        const orientation = ORIENTATIONS[req.aspect] ?? "landscape";
        const queries = buildSearchQueries(req.prompt);

        let image: { bytes: Uint8Array; media_type: string } | null = null;

        for (const query of queries) {
            if (image) break;

            if (this.pexelsKey) {
                image = await this.tryPexels(query, orientation);
                if (image) { console.log(`[stock] Pexels hit: "${query}"`); break; }
            }

            if (this.unsplashKey) {
                image = await this.tryUnsplash(query, orientation);
                if (image) { console.log(`[stock] Unsplash hit: "${query}"`); break; }
            }

            if (this.pixabayKey) {
                image = await this.tryPixabay(query, orientation);
                if (image) { console.log(`[stock] Pixabay hit: "${query}"`); break; }
            }
        }

        if (!image) {
            throw new ProviderError(`${this.id} no results for: ${queries.join(" | ")}`);
        }

        const usage: Usage = {
            input_tokens: 0,
            output_tokens: 0,
            units: 1,
            cost_usd: 0,
            provider: "stock",
            model: "pexels+unsplash+pixabay",
        };

        return { images: [image], usage };
    }

    /**
     * Real stock footage for the same search terms, tried in the same source
     * order as `generate`. Unsplash has no video API, so it is skipped here.
     * Returns null (never throws) when nothing was found — a scene falling
     * back to a still image is the expected, common case, not an error.
     */
    async generateVideo(req: { prompt: string; aspect: Aspect }) {
        const orientation = ORIENTATIONS[req.aspect] ?? "landscape";
        const queries = buildSearchQueries(req.prompt);

        let video: { bytes: Uint8Array; media_type: string } | null = null;

        for (const query of queries) {
            if (video) break;

            if (this.pexelsKey) {
                video = await this.tryPexelsVideo(query, orientation);
                if (video) { console.log(`[stock] Pexels video hit: "${query}"`); break; }
            }

            if (this.pixabayKey) {
                video = await this.tryPixabayVideo(query, orientation);
                if (video) { console.log(`[stock] Pixabay video hit: "${query}"`); break; }
            }
        }

        if (!video) return null;

        const usage: Usage = {
            input_tokens: 0,
            output_tokens: 0,
            units: 1,
            cost_usd: 0,
            provider: "stock",
            model: "pexels+pixabay-video",
        };

        return { video, usage };
    }

    private async tryPexelsVideo(query: string, orientation: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=3&size=medium`;
            const res = await this.fetchImpl(url, {
                headers: { Authorization: this.pexelsKey! },
            });
            if (!res.ok) return null;
            const data = (await res.json()) as {
                videos?: Array<{
                    duration?: number;
                    video_files?: Array<{ link?: string; width?: number; height?: number; quality?: string; file_type?: string }>;
                }>;
            };
            // Videos run long (minutes); a clip that never has to loop or stall
            // matters more here than in shorts, but anything over ~40s is
            // wasted download for a scene that plays for a few seconds.
            const clip = data.videos?.find((v) => (v.duration ?? 0) > 0 && (v.duration ?? 999) <= 40) ?? data.videos?.[0];
            const file = pickVideoFile(clip?.video_files);
            if (!file?.link) return null;
            return this.downloadVideo(file.link);
        } catch {
            return null;
        }
    }

    private async tryPixabayVideo(query: string, orientation: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            const orient = orientation === "square" ? "all" : orientation;
            const url = `https://pixabay.com/api/videos/?key=${this.pixabayKey}&q=${encodeURIComponent(query)}&orientation=${orient}&per_page=3`;
            const res = await this.fetchImpl(url);
            if (!res.ok) return null;
            const data = (await res.json()) as {
                hits?: Array<{
                    duration?: number;
                    videos?: Record<string, { url?: string; width?: number; height?: number } | undefined>;
                }>;
            };
            const hit = data.hits?.find((h) => (h.duration ?? 0) > 0 && (h.duration ?? 999) <= 40) ?? data.hits?.[0];
            // Pixabay's tiers, largest to smallest: large, medium, small, tiny.
            // "medium" keeps the base64 payload to long-compose reasonable
            // without falling to a soft, upscaled "small"/"tiny" clip.
            const videoUrl = hit?.videos?.["medium"]?.url ?? hit?.videos?.["small"]?.url ?? hit?.videos?.["large"]?.url;
            if (!videoUrl) return null;
            return this.downloadVideo(videoUrl);
        } catch {
            return null;
        }
    }

    private async downloadVideo(url: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            const res = await this.fetchImpl(url);
            if (!res.ok) return null;
            const contentType = res.headers.get("content-type") ?? "video/mp4";
            const bytes = new Uint8Array(await res.arrayBuffer());
            // A real clip is at minimum hundreds of KB; anything smaller is an
            // error page or an empty stub, same guard as downloadImage.
            if (bytes.byteLength < 50_000) return null;
            return { bytes, media_type: contentType.split(";")[0]! };
        } catch {
            return null;
        }
    }

    private async tryPexels(query: string, orientation: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=3&size=large`;
            const res = await this.fetchImpl(url, {
                headers: { Authorization: this.pexelsKey! },
            });
            if (!res.ok) return null;
            const data = (await res.json()) as { photos?: Array<{ src?: { large2x?: string; large?: string } }> };
            const photo = data.photos?.[0];
            const imageUrl = photo?.src?.large2x ?? photo?.src?.large;
            if (!imageUrl) return null;
            return this.downloadImage(imageUrl);
        } catch {
            return null;
        }
    }

    private async tryUnsplash(query: string, orientation: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=3`;
            const res = await this.fetchImpl(url, {
                headers: { Authorization: `Client-ID ${this.unsplashKey}` },
            });
            if (!res.ok) return null;
            const data = (await res.json()) as { results?: Array<{ urls?: { regular?: string } }> };
            const photo = data.results?.[0];
            const imageUrl = photo?.urls?.regular;
            if (!imageUrl) return null;
            return this.downloadImage(imageUrl);
        } catch {
            return null;
        }
    }

    private async tryPixabay(query: string, orientation: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            if (!this.pixabayKey) return null;
            const orient = orientation === "square" ? "all" : orientation;
            const url = `https://pixabay.com/api/?key=${this.pixabayKey}&q=${encodeURIComponent(query)}&orientation=${orient}&per_page=3&image_type=photo&min_width=1280`;
            const res = await this.fetchImpl(url);
            if (!res.ok) return null;
            const data = (await res.json()) as { hits?: Array<{ largeImageURL?: string }> };
            const hit = data.hits?.[0];
            if (!hit?.largeImageURL) return null;
            return this.downloadImage(hit.largeImageURL);
        } catch {
            return null;
        }
    }

    private async downloadImage(url: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
        try {
            const res = await this.fetchImpl(url);
            if (!res.ok) return null;
            const contentType = res.headers.get("content-type") ?? "image/jpeg";
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.byteLength < 5000) return null;
            return { bytes, media_type: contentType.split(";")[0]! };
        } catch {
            return null;
        }
    }
}

/**
 * Pexels lists several encodes per video, sd through 4k. Pick the smallest
 * one at or above 960px wide — enough detail after long-compose's own
 * scale+crop, without downloading a multi-hundred-MB 4k file for a base64
 * JSON payload that has to fit alongside every other scene in the request.
 */
function pickVideoFile(
    files: Array<{ link?: string; width?: number; height?: number; quality?: string; file_type?: string }> | undefined,
): { link?: string } | undefined {
    if (!files || files.length === 0) return undefined;
    const mp4 = files.filter((f) => !f.file_type || f.file_type === "video/mp4");
    const candidates = mp4.length > 0 ? mp4 : files;
    const sized = candidates.filter((f) => (f.width ?? 0) >= 960);
    const pool = sized.length > 0 ? sized : candidates;
    return pool.reduce((best, f) => ((f.width ?? 0) < (best.width ?? Infinity) ? f : best), pool[0]!);
}

/**
 * Build multiple search queries from specific to broad.
 * The visual planner outputs prompts like:
 *   "Cinematic still frame... Andes mountain range aerial, old colonial map of Chile. cinematic. No text..."
 *
 * We extract the actual subjects and try them as search queries.
 */
function buildSearchQueries(prompt: string): string[] {
    let clean = prompt
        .replace(/^Cinematic still frame[^.]*\.\s*/i, "")
        .replace(/^Ultra-realistic[^.]*\.\s*/i, "")
        .replace(/\.\s*No text[^]*$/i, "")
        .replace(/\.\s*cinematic[^.]*$/i, "")
        .replace(/\.\s*dramatic[^.]*$/i, "")
        .trim();

    const terms = clean.split(/[,.]/)
        .map(s => s.trim())
        .filter(s => s.length > 3 && !s.match(/^(cinematic|dramatic|photorealistic|aerial|close-up|low-angle|high-angle)/i));

    const queries: string[] = [];

    // Query 1: first 2 terms combined (most specific)
    if (terms.length >= 2) {
        queries.push(terms.slice(0, 2).join(" "));
    }

    // Query 2: first term alone (main subject)
    if (terms[0]) {
        queries.push(terms[0]);
    }

    // Query 3: simplified first term (strip adjectives)
    if (terms[0]) {
        const simplified = terms[0]
            .replace(/\b(ancient|old|modern|dramatic|vast|massive|huge|stunning|beautiful|cinematic|weathered|narrow|wide)\b/gi, "")
            .replace(/\s+/g, " ")
            .trim();
        if (simplified !== terms[0] && simplified.length > 3) {
            queries.push(simplified);
        }
    }

    // Query 4: second term as fallback
    if (terms[1]) {
        queries.push(terms[1]);
    }

    return queries.length > 0 ? queries : [clean.slice(0, 50)];
}
