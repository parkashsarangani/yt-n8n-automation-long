import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolverPath = path.join(ROOT, "src/workers/visual-beat-resolver.ts");

async function resolverSource(): Promise<string> {
  return readFile(resolverPath, "utf8");
}

test("RFC0010 resolver no longer relies on the dead FreeLLM vision breaker", async () => {
  const source = await resolverSource();
  assert.doesNotMatch(source, /freeVisionTripped|vision-route-health/);
});

test("a null direct-vision result latches QA unavailable in every media candidate loop", async () => {
  const source = await resolverSource();
  assert.match(source, /image-bank candidate could not be scored/);
  assert.match(source, /generated-image candidate could not be scored/);
  assert.match(source, /stock-video window could not be scored/);
  assert.match(source, /generated-video candidate could not be scored/);
  assert.match(source, /markVisionQaUnavailable\(health,/);
});

test("paid generated-video retries stop and salvage on the direct-QA health latch", async () => {
  const source = await resolverSource();
  const start = source.indexOf("async function generateVideo(");
  const end = source.indexOf("\nasync function resolveMode(", start);
  assert.ok(start >= 0 && end > start, "generateVideo implementation must be present");
  const implementation = source.slice(start, end);
  assert.match(implementation, /if \(health\.unavailable\) break;/);
  assert.match(implementation, /if \(salvage && health\.unavailable\)/);
  assert.match(implementation, /QA_UNAVAILABLE: vision QA unreachable; generated video shipped unverified/);
});

test("continuity reference frames are restricted to generated identity-capable media", async () => {
  const source = await resolverSource();
  assert.match(source, /selected === "generated_image" \|\| selected === "generated_video"/);
  assert.doesNotMatch(source, /selected !== "stock_video"/);
});
