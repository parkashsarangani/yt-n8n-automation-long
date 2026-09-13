/**
 * Google Drive file exchange for the editor handoff.
 *
 * The only file that knows Drive exists -- everything upstream sees a
 * DriveExchange, mirroring the youtube.ts pattern (RFC 0004).
 *
 * Scope: this takes an OAuth access token / token factory. Acquiring and
 * refreshing that token is deliberately out of scope here, same as YouTubeTarget.
 */

import { ProviderError } from "../provider.ts";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveExchange {
  readonly id: string;
  /** Create a subfolder under `parentId`, returning its folder id. */
  createFolder(name: string, parentId: string): Promise<string>;
  uploadFile(folderId: string, name: string, bytes: Uint8Array, mimeType: string): Promise<string>;
  listFiles(folderId: string): Promise<DriveFile[]>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  /** A viewer-facing link to a folder, for the operator/engine UI. */
  folderUrl(folderId: string): string;
}

export interface DriveProviderOptions {
  /** A valid OAuth2 access token, or a function that returns one. */
  accessToken: string | (() => Promise<string>);
  baseUrl?: string;
  uploadUrl?: string;
  fetchImpl?: typeof fetch;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveProvider implements DriveExchange {
  readonly id = "drive";
  private readonly token: () => Promise<string>;
  private readonly baseUrl: string;
  private readonly uploadUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DriveProviderOptions) {
    this.token = typeof opts.accessToken === "string" ? async () => opts.accessToken as string : opts.accessToken;
    this.baseUrl = opts.baseUrl ?? "https://www.googleapis.com/drive/v3";
    this.uploadUrl = opts.uploadUrl ?? "https://www.googleapis.com/upload/drive/v3";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const token = await this.token();
    const res = await this.fetchImpl(`${this.baseUrl}/files?fields=id`, {
      signal: AbortSignal.timeout(120_000),
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (!res.ok) throw new ProviderError(`drive folder create failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new ProviderError("drive folder create returned no id");
    return body.id;
  }

  async uploadFile(folderId: string, name: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    const token = await this.token();
    // multipart/related: metadata part + content part, in one request -- the
    // simplest correct way to set both the name/parent and the bytes at once.
    const boundary = `vidgen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name, parents: [folderId] });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = new Blob([head, bytes, tail]);

    const res = await this.fetchImpl(`${this.uploadUrl}/files?uploadType=multipart&fields=id`, {
      signal: AbortSignal.timeout(300_000),
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new ProviderError(`drive upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const result = (await res.json()) as { id?: string };
    if (!result.id) throw new ProviderError("drive upload returned no id");
    return result.id;
  }

  async listFiles(folderId: string): Promise<DriveFile[]> {
    const token = await this.token();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const files: DriveFile[] = [];
    let page: string | undefined;
    do {
      const res = await this.fetchImpl(`${this.baseUrl}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType)&pageSize=100${page ? "&pageToken="+encodeURIComponent(page) : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new ProviderError(`drive list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      page = body.nextPageToken;
    } while(page);
    return files;
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const token = await this.token();
    const res = await this.fetchImpl(`${this.baseUrl}/files/${fileId}?alt=media`, {
      signal: AbortSignal.timeout(300_000),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ProviderError(`drive download failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  folderUrl(folderId: string): string {
    return `https://drive.google.com/drive/folders/${folderId}`;
  }
}
