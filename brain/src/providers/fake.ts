/**
 * Deterministic in-memory provider for tests and dry runs.
 *
 * Exists so the runner, agents, and graph can be tested with zero network and
 * zero cost — which is only possible because agents are pure functions of their
 * inputs (RFC 0003 rule 2).
 */

import {
  ProviderRefusal,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ProviderCapabilities,
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
