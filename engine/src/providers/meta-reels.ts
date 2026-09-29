/**
 * Facebook Page Reels and Instagram Reels publishing via the Meta Graph API
 * (Shorts phase 2, 2026-09-29). Flows per Meta's docs (checked 2026-09-29,
 * Graph API v25.0 -- the same version the operator's existing n8n Facebook
 * workflow uses):
 *
 * Facebook: POST /{page}/video_reels upload_phase=start -> {video_id,
 *   upload_url}; POST the bytes to rupload (Authorization: OAuth, offset,
 *   file_size); POST /{page}/video_reels upload_phase=finish
 *   video_state=PUBLISHED; GET /{video_id}?fields=status. Page token with
 *   pages_manage_posts. 3-90 s, 9:16. 30 posts / 24 h.
 * Instagram: POST /{ig}/media media_type=REELS upload_type=resumable ->
 *   {id, uri}; POST the bytes to rupload ig-api-upload; poll
 *   /{container}?fields=status_code until FINISHED; POST /{ig}/media_publish
 *   creation_id. instagram_content_publish on a Professional account.
 *   100 posts / 24 h.
 *
 * Bytes are uploaded directly, so no public video URL is needed (the server
 * is LAN-only). The token travels in request bodies/headers, never in a URL,
 * so it cannot leak into logs.
 */

export interface ReelPost {
  video: Uint8Array;
  media_type: string;
  caption: string;
  title: string;
}

export interface ReelResult {
  external_id: string;
  url: string;
}

export interface ReelsTarget {
  readonly id: "facebook" | "instagram";
  post(p: ReelPost): Promise<ReelResult>;
}

export class MetaApiError extends Error {}

export interface MetaOptions {
  accessToken: string;
  version?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const GRAPH = "https://graph.facebook.com";

abstract class MetaClient {
  protected readonly token: string;
  protected readonly version: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly pollIntervalMs: number;
  protected readonly maxPolls: number;

  constructor(opts: MetaOptions) {
    this.token = opts.accessToken;
    this.version = opts.version ?? "v25.0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.maxPolls = opts.maxPolls ?? 60;
  }

  /** A Graph call. POST sends a form body carrying the token; GET sends it as an OAuth header. Never in the URL. */
  protected async graph(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = `${GRAPH}/${this.version}/${path}`;
    const res = method === "GET"
      ? await this.fetchImpl(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: `OAuth ${this.token}` } })
      : await this.fetchImpl(url, {
          method,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...params, access_token: this.token }),
        });
    return this.read(res, `${method} ${path}`);
  }

  protected async upload(url: string, video: Uint8Array): Promise<void> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `OAuth ${this.token}`, offset: "0", file_size: String(video.byteLength) },
      body: video,
    });
    const body = await this.read(res, "upload");
    if (body["success"] === false) throw new MetaApiError(`upload was not accepted: ${JSON.stringify(body).slice(0, 300)}`);
  }

  private async read(res: Response, what: string): Promise<Record<string, unknown>> {
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
    const err = body["error"] as { message?: string; code?: number } | undefined;
    if (!res.ok || err) {
      const detail = err?.message ?? text.slice(0, 300);
      throw new MetaApiError(`${what} failed (${res.status}${err?.code ? `, code ${err.code}` : ""}): ${redact(detail, this.token)}`);
    }
    return body;
  }
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[REDACTED]") : text;
}

export class FacebookReelsTarget extends MetaClient implements ReelsTarget {
  readonly id = "facebook" as const;
  constructor(private readonly pageId: string, opts: MetaOptions) { super(opts); }

  async post(p: ReelPost): Promise<ReelResult> {
    const start = await this.graph("POST", `${this.pageId}/video_reels`, { upload_phase: "start" });
    const videoId = String(start["video_id"] ?? "");
    if (!videoId) throw new MetaApiError("Facebook did not return a video_id for the upload session");
    const uploadUrl = String(start["upload_url"] ?? `https://rupload.facebook.com/video-upload/${this.version}/${videoId}`);
    await this.upload(uploadUrl, p.video);
    await this.graph("POST", `${this.pageId}/video_reels`, {
      upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: p.caption, title: p.title,
    });
    // Publishing is asynchronous. Wait for it to settle so a processing error
    // surfaces here (and is retried/alerted) rather than as a missing Reel.
    for (let i = 0; i < this.maxPolls; i++) {
      const status = (await this.graph("GET", videoId, { fields: "status" }))["status"] as
        { video_status?: string; publishing_phase?: { status?: string }; processing_phase?: { status?: string; error?: { message?: string } } } | undefined;
      if (status?.video_status === "error" || status?.processing_phase?.status === "error") {
        throw new MetaApiError(`Facebook failed to process the Reel: ${status.processing_phase?.error?.message ?? "processing error"}`);
      }
      if (status?.video_status === "ready" || status?.publishing_phase?.status === "complete") break;
      await this.sleep(this.pollIntervalMs);
    }
    return { external_id: videoId, url: `https://www.facebook.com/reel/${videoId}` };
  }
}

export class InstagramReelsTarget extends MetaClient implements ReelsTarget {
  readonly id = "instagram" as const;
  constructor(private readonly igUserId: string, opts: MetaOptions) { super(opts); }

  async post(p: ReelPost): Promise<ReelResult> {
    const container = await this.graph("POST", `${this.igUserId}/media`, {
      media_type: "REELS", upload_type: "resumable", caption: p.caption, share_to_feed: "true",
    });
    const containerId = String(container["id"] ?? "");
    if (!containerId) throw new MetaApiError("Instagram did not return a media container id");
    const uploadUrl = String(container["uri"] ?? `https://rupload.facebook.com/ig-api-upload/${this.version}/${containerId}`);
    await this.upload(uploadUrl, p.video);
    for (let i = 0; ; i++) {
      const code = String((await this.graph("GET", containerId, { fields: "status_code" }))["status_code"] ?? "");
      if (code === "FINISHED") break;
      if (code === "ERROR" || code === "EXPIRED") throw new MetaApiError(`Instagram could not process the Reel (status ${code})`);
      if (i + 1 >= this.maxPolls) throw new MetaApiError(`Instagram was still processing the Reel after ${this.maxPolls} checks`);
      await this.sleep(this.pollIntervalMs);
    }
    const published = await this.graph("POST", `${this.igUserId}/media_publish`, { creation_id: containerId });
    const mediaId = String(published["id"] ?? "");
    if (!mediaId) throw new MetaApiError("Instagram did not return the published media id");
    let url = `https://www.instagram.com/reel/${mediaId}`;
    try {
      const permalink = (await this.graph("GET", mediaId, { fields: "permalink" }))["permalink"];
      if (typeof permalink === "string" && permalink) url = permalink;
    } catch { /* the Reel is published; a missing permalink is cosmetic */ }
    return { external_id: mediaId, url };
  }
}
