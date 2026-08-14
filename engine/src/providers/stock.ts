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
