import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Studio exposes recovery for blocked runs even when failure details are absent", async () => {
  const html = await readFile(path.join(ROOT, "ui", "index.html"), "utf8");
  assert.match(html, /retryable=run\.status===\"blocked\"/);
  assert.match(html, /Resume blocked run/);
  assert.match(html, /Completed story, script, voice and other successful artifacts are preserved/);
  assert.match(html, /\/api\/runs\/\$\{encodeURIComponent\(selected\)\}\/retry/);
  assert.match(html, /retry\.disabled=true/);
});
