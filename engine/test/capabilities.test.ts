import test from "node:test";
import assert from "node:assert/strict";
import { capabilityReport, credentialsSatisfied, STAGES } from "../src/capabilities.ts";

const stage = (id: string) => STAGES.find((item) => item.id === id)!;

test("audio-first capabilities expose no retired visual QA or media-generation stages", () => {
  assert.deepEqual(STAGES.map((item) => item.id), ["reasoning", "speech", "images", "renderer", "publish", "analytics"]);
  assert.equal(credentialsSatisfied(stage("images"), { FAL_KEY: "fal" }), true);
  assert.equal(credentialsSatisfied(stage("images"), { FREELLMAPI_API_KEY: "free" }), false);
});

test("thumbnail artwork is optional and reports its gradient fallback", () => {
  const report = capabilityReport({ allowPublish: false, env: {} });
  const images = report.find((item) => item.id === "images")!;
  assert.equal(images.real, false);
  assert.equal(images.provider, "generated gradient");
  assert.deepEqual(images.missing, ["FAL_KEY"]);
});
