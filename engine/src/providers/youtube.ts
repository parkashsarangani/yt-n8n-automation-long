/**
 * YouTube publish target (RFC 0004).
 *
 * The only file that knows YouTube exists. Everything upstream sees a
 * PublishTarget and reads requirements() — nothing branches on "youtube".
 *
 * Scope: this takes an OAuth access token. Acquiring and refreshing that token
 * is deliberately out of scope — token custody belongs with whatever operates
 * the deployment, not in the engine.
 *
 * NOT YET RUN AGAINST THE REAL API.
 */

import {
  ProviderError,
  type PublishRequest,
  type PublishResult,
  type PublishTarget,
  type TargetRequirements,
} from "../provider.ts";

export interface YouTubeOptions {
  /** A valid OAuth2 access token, or a function that returns one. */
  accessToken: string | (() => Promise<string>);
  /** YouTube category id. 27 = Education, 22 = People & Blogs. */
  categoryId?: string;
  /**
   * BCP-47 tag for both the spoken audio and the title/description. YouTube
   * treats these as separate fields and guesses when they are absent, which
   * decides who the video is recommended to and whether auto-translation and
   * auto-dubbing behave -- too consequential to leave to a guess.
   */
  language?: string;
  /** "youtube" (standard licence) or "creativeCommon". */
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  /**
   * Declared on every upload, not only when true: YouTube's own default is
   * false, but stating it makes the answer deliberate and visible in the
   * request rather than inherited.
   */
  paidProductPlacement?: boolean;
  defaultPrivacy?: "public" | "unlisted" | "private";
  baseUrl?: string;
  uploadUrl?: string;
  fetchImpl?: typeof fetch;
}

export class YouTubeTarget implements PublishTarget {
  readonly id = "youtube";
  private readonly token: () => Promise<string>;
  private readonly categoryId: string;
  private readonly language: string;
  private readonly license: "youtube" | "creativeCommon";
  private readonly embeddable: boolean;
  private readonly publicStatsViewable: boolean;
  private readonly paidProductPlacement: boolean;
  private readonly defaultPrivacy: "public" | "unlisted" | "private";
  private readonly baseUrl: string;
  private readonly uploadUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: YouTubeOptions) {
    this.token =
      typeof opts.accessToken === "string"
        ? async () => opts.accessToken as string
        : opts.accessToken;
    this.categoryId = opts.categoryId ?? "27";
    this.language = opts.language ?? "en";
    this.license = opts.license ?? "youtube";
    this.embeddable = opts.embeddable ?? true;
    this.publicStatsViewable = opts.publicStatsViewable ?? true;
    this.paidProductPlacement = opts.paidProductPlacement ?? false;
    this.defaultPrivacy = opts.defaultPrivacy ?? "private";
    this.baseUrl = opts.baseUrl ?? "https://www.googleapis.com/youtube/v3";
    this.uploadUrl = opts.uploadUrl ?? "https://www.googleapis.com/upload/youtube/v3";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  requirements(): TargetRequirements {
    return {
      aspects: ["16:9", "9:16"],
      max_duration_sec: 12 * 60 * 60,
      max_title_chars: 100,
      max_description_chars: 5000,
      // YouTube does not publish a tag-count cap; the real constraint is the
      // 500-character aggregate below. The count here is a sanity bound.
      max_tags: 30,
      max_tag_chars: 500,
      requires_synthetic_media_disclosure: true,
      supports_custom_thumbnail: true,
    };
  }

  async publish(
    req: PublishRequest,
    opts: { onProgress?: (detail: string) => void | Promise<void> } = {},
  ): Promise<PublishResult> {
    const token = await this.token();

    // 1. Resumable upload: metadata first, bytes second. Simpler to get right
    //    with fetch than a hand-built multipart/related body.
    const start = await this.fetchImpl(
      `${this.uploadUrl}/videos?uploadType=resumable&part=snippet,status,paidProductPlacementDetails`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": req.media_type,
          "X-Upload-Content-Length": String(req.video.byteLength),
        },
        body: JSON.stringify({
          snippet: {
            title: req.metadata.title,
            description: req.metadata.description ?? "",
            tags: req.metadata.tags ?? [],
            categoryId: this.categoryId,
            // Spoken language and metadata language are separate fields, and
            // YouTube guesses both when they are absent.
            defaultAudioLanguage: this.language,
            defaultLanguage: this.language,
          },
          status: this.statusFields(req.metadata),
          paidProductPlacementDetails: { hasPaidProductPlacement: this.paidProductPlacement },
        }),
      },
    );
    if (!start.ok) {
      throw new ProviderError(
        `youtube upload init failed (${start.status}): ${(await start.text()).slice(0, 300)}`,
      );
    }
    const location = start.headers.get("location");
    if (!location) {
      throw new ProviderError("youtube upload init returned no Location header");
    }
    await opts.onProgress?.("upload session opened");

    const upload = await this.fetchImpl(location, {
      method: "PUT",
      headers: { "Content-Type": req.media_type },
      body: new Blob([req.video], { type: req.media_type }),
    });
    if (!upload.ok) {
      throw new ProviderError(
        `youtube upload failed (${upload.status}): ${(await upload.text()).slice(0, 300)}`,
      );
    }
    const video = (await upload.json()) as { id?: string };
    if (!video.id) throw new ProviderError("youtube upload returned no video id");
    await opts.onProgress?.(`uploaded as ${video.id}`);

    // 2. Declare AI-generated content. A separate call, as in the predecessor
    //    pipeline — insert does not reliably accept the field.
    const disclosed = await this.disclose(token, video.id, req.metadata);

    // 3. Custom thumbnail. Requires a phone-verified channel; a refusal here
    //    must NOT fail an otherwise-successful publish, but it must be visible,
    //    because silently falling back to an auto-frame thumbnail is exactly
    //    the kind of quiet degradation that skews CTR.
    let thumbnailSet = false;
    if (req.thumbnail) {
      thumbnailSet = await this.setThumbnail(token, video.id, req.thumbnail);
      if (!thumbnailSet) {
        await opts.onProgress?.(
          "thumbnail rejected — channel may not be phone-verified; YouTube will auto-select a frame",
        );
      }
    }

    return {
      external_id: video.id,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      thumbnail_set: thumbnailSet,
      synthetic_media_disclosed: disclosed,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0,
        provider: "youtube",
        model: "data-api-v3",
      },
    };
  }

  /** Every status field we declare, in one place so insert and update agree. */
  private statusFields(metadata: PublishRequest["metadata"]): Record<string, unknown> {
    return {
      privacyStatus: metadata.privacy ?? this.defaultPrivacy,
      selfDeclaredMadeForKids: metadata.made_for_kids ?? false,
      license: this.license,
      embeddable: this.embeddable,
      publicStatsViewable: this.publicStatsViewable,
    };
  }

  private async disclose(
    token: string,
    videoId: string,
    metadata: PublishRequest["metadata"],
  ): Promise<boolean> {
    const res = await this.fetchImpl(`${this.baseUrl}/videos?part=status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: videoId,
        // videos.update REPLACES the part it is given, so every status field
        // set at insert has to be restated here or it silently reverts to
        // YouTube's default the moment the AI label is applied.
        status: { ...this.statusFields(metadata), containsSyntheticMedia: true },
      }),
    });
    if (!res.ok) {
      // Disclosure is a policy obligation, not a nicety. However, at this
      // point the video is already uploaded — throwing here leaves a live,
      // undisclosed video AND a failed pipeline. It's better to surface the
      // failure clearly (the caller gets synthetic_media_disclosed=false) and
      // let the operator fix the scope and retry disclosure out-of-band.
      //
      // TODO: Once the OAuth token includes the full `youtube` scope, consider
      // reverting this to a hard throw.
      const body = (await res.text()).slice(0, 300);
      console.error(
        `[youtube] synthetic-media disclosure failed for ${videoId} ` +
        `(${res.status}): ${body}. ` +
        `Action required: re-authorize with the https://www.googleapis.com/auth/youtube scope ` +
        `then manually set containsSyntheticMedia on this video.`,
      );
      return false;
    }
    return true;
  }

  private async setThumbnail(
    token: string,
    videoId: string,
    thumbnail: { bytes: Uint8Array; media_type: string },
  ): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.uploadUrl}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": thumbnail.media_type },
        body: new Blob([thumbnail.bytes], { type: thumbnail.media_type }),
      },
    );
    return res.ok;
  }
}
