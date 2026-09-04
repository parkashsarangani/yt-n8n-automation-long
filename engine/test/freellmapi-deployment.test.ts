import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

test("Long consumes shared FreeLLMAPI infrastructure without declaring a duplicate service or volume", async () => {
  const compose = await readFile(path.join(ROOT, "docker-compose.yml"), "utf8");

  assert.match(compose, /FREELLMAPI_BASE_URL:\s*\$\{FREELLMAPI_BASE_URL:-http:\/\/freellmapi:3001\/v1\}/);
  assert.match(compose, /FREELLMAPI_API_KEY:/);
  assert.match(compose, /FREELLMAPI_TEXT_MODEL:/);
  assert.match(compose, /FREELLMAPI_VISION_MODEL:/);
  assert.doesNotMatch(compose, /^\s{2}freellmapi:\s*$/m, "Shorts must remain the only owner of the FreeLLMAPI container");
  assert.doesNotMatch(compose, /^\s{2}llm-gateway:\s*$/m, "Long owns its application router rather than sharing Shorts paid fallback credentials");
  assert.doesNotMatch(compose, /^\s{2}freellmapi_data:\s*$/m, "Long must not create a second encrypted FreeLLMAPI state volume");
});

test("production deploy attaches engine to the pinned Shorts network and verifies the real container path", async () => {
  const deploy = await readFile(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");

  assert.match(deploy, /yt-n8n-automation-shorts_default/);
  assert.match(deploy, /docker network connect "\$SHARED_LLM_NETWORK" "\$ENGINE_CID"/);
  assert.match(deploy, /http:\/\/freellmapi:3001\/api\/ping/);
  assert.match(deploy, /FREELLMAPI_API_KEY: \$\{\{ secrets\.FREELLMAPI_API_KEY \}\}/);
  assert.match(deploy, /LLM_ROUTER_MODE: \$\{\{ vars\.LLM_ROUTER_MODE \|\| 'freellmapi' \}\}/);
  assert.match(deploy, /warning::shared network/);
  assert.match(deploy, /direct LLM fail-open/);
});
