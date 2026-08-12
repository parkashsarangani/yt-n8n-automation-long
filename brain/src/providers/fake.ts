/**
 * Deterministic in-memory provider for tests and dry runs.
 *
 * Exists so the runner, agents, and graph can be tested with zero network and
 * zero cost — which is only possible because agents are pure functions of their
 * inputs (RFC 0003 rule 2).
 */

import { createHash } from "node:crypto";
import {
  ProviderError,
  ProviderRefusal,
  type Aspect,
  type CompletionRequest,
  type CompletionResult,
  type ImageProvider,
  type ModelProvider,
  type ProviderCapabilities,
  type SpeechProvider,
} from "../provider.ts";

export type FakeHandler = (
  req: CompletionRequest,
  attempt: number,
) => unknown | { __refuse: string };

export class FakeProvider implements ModelProvider {
  readonly id: string;
  /** Every request received, in order — assert against this in tests. */
  readonly calls: CompletionRequest[] = [];
  private attempt = 0;

  constructor(
    private readonly handler: FakeHandler,
    id = "fake/deterministic",
  ) {
    this.id = id;
  }

  capabilities(): ProviderCapabilities {
    return { structuredOutput: "native", maxOutputTokens: 64_000 };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const value = this.handler(req, this.attempt++);
    if (value && typeof value === "object" && "__refuse" in value) {
      throw new ProviderRefusal(
        `fake provider refused: ${String((value as { __refuse: string }).__refuse)}`,
        String((value as { __refuse: string }).__refuse),
      );
    }
    return {
      value,
      usage: {
        input_tokens: Math.ceil(req.prompt.length / 4),
        output_tokens: 100,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
      providerRef: this.id,
    };
  }
}

/** Deterministic bytes derived from the input, so identical inputs dedup. */
function fakeBytes(seed: string, size = 64): Uint8Array {
  const out = new Uint8Array(size);
  let digest = createHash("sha256").update(seed).digest();
  for (let i = 0; i < size; i++) {
    if (i % 32 === 0 && i > 0) digest = createHash("sha256").update(digest).digest();
    out[i] = digest[i % 32]!;
  }
  return out;
}

export class FakeSpeechProvider implements SpeechProvider {
  readonly id = "fake/speech";
  readonly calls: Array<{ text: string; voice: string; prev?: string; next?: string }> = [];
  /** Texts that should fail, to exercise worker error paths. */
  constructor(private readonly failOn: (text: string) => boolean = () => false) {}

  async synthesize(req: {
    text: string;
    voice: string;
    context?: { prev?: string; next?: string };
  }) {
    this.calls.push({
      text: req.text,
      voice: req.voice,
      ...(req.context?.prev !== undefined ? { prev: req.context.prev } : {}),
      ...(req.context?.next !== undefined ? { next: req.context.next } : {}),
    });
    if (this.failOn(req.text)) throw new ProviderError(`fake speech failed for: ${req.text}`);
    return {
      audio: fakeBytes(`audio:${req.voice}:${req.text}`),
      media_type: "audio/mpeg",
      alignment: { characters: [...req.text], note: "fake alignment" },
      duration_sec: Math.max(1, req.text.split(/\s+/).length / 2.5),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: req.text.length,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}

export class FakeImageProvider implements ImageProvider {
  readonly id = "fake/image";
  readonly prompts: string[] = [];
  constructor(private readonly failOn: (prompt: string) => boolean = () => false) {}

  async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    this.prompts.push(req.prompt);
    if (this.failOn(req.prompt)) throw new ProviderError(`fake image failed for: ${req.prompt}`);
    const n = req.count ?? 1;
    return {
      images: Array.from({ length: n }, (_, i) => ({
        bytes: fakeBytes(`image:${req.aspect}:${req.prompt}:${i}`, 128),
        media_type: "image/png",
      })),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: n,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}
