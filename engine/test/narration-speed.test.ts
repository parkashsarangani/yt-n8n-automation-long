import test from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";

test("narration speed is passed to ElevenLabs and invalid values fail before spending", async () => {
  const previous = process.env["ELEVENLABS_SPEED"];
  try {
    process.env["ELEVENLABS_SPEED"] = "0.88";
    const provider = new ElevenLabsProvider({ apiKey: "fixture", fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).voice_settings.speed, 0.88);
      return new Response(JSON.stringify({audio_base64: "YQ=="}), {status: 200});
    } });
    await provider.synthesize({text: "Let me finish this thought.", voice: "fixture"});
    process.env["ELEVENLABS_SPEED"] = "NaN";
    assert.throws(() => new ElevenLabsProvider({apiKey: "fixture"}), /ELEVENLABS_SPEED/);
  } finally {
    if (previous === undefined) delete process.env["ELEVENLABS_SPEED"];
    else process.env["ELEVENLABS_SPEED"] = previous;
  }
});
