import test from "node:test";
import assert from "node:assert/strict";
import { capabilityReport, credentialsSatisfied, STAGES } from "../src/capabilities.ts";

const stage = (id: string) => STAGES.find((item) => item.id === id)!;

test("audio-first capabilities expose no retired visual QA or media-generation stages", () => {
  assert.deepEqual(STAGES.map((item) => item.id), ["reasoning", "speech", "renderer", "publish", "editor_handoff", "analytics"]);
});

test("generated thumbnail artwork is retired: no image stage, and a FAL key enables nothing", () => {
  // Operator decision 2026-09-27: only the editor's thumbnail is published.
  const report = capabilityReport({ allowPublish: false, env: { FAL_KEY: "fal" } });
  assert.equal(report.some((item) => item.id === "images"), false);
  assert.equal(STAGES.some((item) => JSON.stringify(item).includes("FAL_")), false);
});
