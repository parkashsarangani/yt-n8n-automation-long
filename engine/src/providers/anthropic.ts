/**
 * Backward-compatible provider shim.
 *
 * Older service wiring imports `AnthropicProvider`, but production reasoning is
 * now Ollama-only. This file deliberately contains no Anthropic SDK import and
 * no remote fallback. Missing Ollama/model availability is reported by the
 * Ollama provider as a hard ProviderError.
 */

import type { CompletionRequest } from "../provider.ts";
import {
  OllamaProvider,
  defaultOllamaBaseUrl,
  estimateOllamaCost,
  selectOllamaModel,
  type OllamaProviderOptions,
} from "./ollama.ts";

export interface AnthropicProviderOptions extends Omit<OllamaProviderOptions, "model" | "fastModel"> {
  /** Retained only so old constructor calls still typecheck. Ignored. */
  model?: string;
  /** Retained only so old credential UI/tests do not imply a remote call. Ignored. */
  apiKey?: string;
  /** Removed with the Anthropic SDK path. Supplying it has no effect. */
  client?: unknown;
}

export class AnthropicProvider extends OllamaProvider {
  constructor(opts: AnthropicProviderOptions = {}) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? defaultOllamaBaseUrl(),
      model: selectOllamaModel(opts.effort),
      fastModel: selectOllamaModel("low"),
    });
  }
}

export function effectiveAnthropicModel(
  _configuredModel: string,
  effort: CompletionRequest["effort"],
): string {
  return selectOllamaModel(effort);
}

export function supportsAdaptiveThinking(_model: string): boolean {
  return false;
}

export function supportsOutputConfigEffort(_model: string): boolean {
  return false;
}

export const estimateCost = estimateOllamaCost;
