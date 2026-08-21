/**
 * AnthropicProvider is the one file that talks to the real Anthropic SDK -
 * every other engine test exercises ModelProvider through FakeProvider
 * instead, so this file otherwise has zero coverage of its actual request
 * shape or response handling. These tests stub just the client's
 * messages.stream() surface (the real SDK isn't invoked, no network, no cost)
 * to verify the provider streams instead of calling create(), and that it
 * still reproduces the same success/refusal/truncation/non-JSON handling a
 * non-streaming response would have.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { ProviderError, ProviderRefusal } from "../src/provider.ts";

interface StreamCall {
  body: Record<string, unknown>;
}

function stubClient(finalMessage: () => Promise<unknown>, calls: StreamCall[]) {
  return {
    messages: {
      stream(body: Record<string, unknown>) {
        calls.push({ body });
        return { finalMessage };
      },
      // If the provider ever calls create() instead of stream(), fail loudly
      // rather than silently succeeding against the wrong method.
      create() {
        throw new Error("AnthropicProvider must call messages.stream(), not messages.create()");
      },
    },
  } as unknown as ConstructorParameters<typeof AnthropicProvider>[0]["client"];
}

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };

test("streams instead of using create(), and calls finalMessage() for the result", async () => {
  const calls: StreamCall[] = [];
  const client = stubClient(
    async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    calls,
  );
  const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

  const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 32000 });

  assert.equal(calls.length, 1, "expected exactly one messages.stream() call");
  assert.equal(calls[0]!.body["max_tokens"], 32000);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.providerRef, "anthropic/claude-sonnet-5");
});

test("a refusal surfaces as ProviderRefusal, not a crash on empty content", async () => {
  const calls: StreamCall[] = [];
  const client = stubClient(
    async () => ({
      stop_reason: "refusal",
      stop_details: { category: "policy" },
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
    calls,
  );
  const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderRefusal);
      assert.equal(err.category, "policy");
      return true;
    },
  );
});

test("hitting max_tokens is reported as truncation, naming the actual budget used", async () => {
  const calls: StreamCall[] = [];
  const client = stubClient(
    async () => ({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "{" }],
      usage: { input_tokens: 10, output_tokens: 32000 },
    }),
    calls,
  );
  const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 32000 }),
    /hit max_tokens \(32000\)/,
  );
});

test("non-JSON text despite structured output is a provider error, not a silent bad parse", async () => {
  const calls: StreamCall[] = [];
  const client = stubClient(
    async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "sorry, I cannot help with that" }],
      usage: { input_tokens: 10, output_tokens: 8 },
    }),
    calls,
  );
  const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    /returned non-JSON despite structured output/,
  );
});

test("a stream failure (e.g. the SDK's own 10-minute non-streaming guard, or a network error) is wrapped as ProviderError", async () => {
  const calls: StreamCall[] = [];
  const client = stubClient(async () => {
    throw new Error("Streaming is required for operations that may take longer than 10 minutes.");
  }, calls);
  const provider = new AnthropicProvider({ model: "claude-sonnet-5", client });

  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 32000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /request failed/);
      return true;
    },
  );
});
