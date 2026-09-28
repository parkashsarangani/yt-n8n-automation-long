/**
 * A custom episode's YouTube title is typed by the editor and must be
 * published word for word. Production 2026-09-28: the SEO step reused a
 * working title cut from the hook, and the video went live as "...the way I
 * talk…". Now the editor types the title, and whatever the SEO model returns
 * for a human-authored story, the title is the story's.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { Runner, lockHumanAuthoredTitle } from "../src/runner.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { buildManualEpisode } from "../src/manual-script.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDITOR_TITLE = "Why a Stranger's One Sentence Changed How I Talk";
const NARRATION = "A stranger said one sentence to me at a bus stop.\n\nIt changed how I talk to everyone.\n\nHere is what she said, and why it works.";

/** The SEO model "helpfully" rewrites the title, as an LLM is allowed to. */
const seoResponse = {
  payload: {
    title: "One Sentence That Will Change How You Communicate Forever",
    description: "A short story about a stranger at a bus stop and the one sentence that changed how the narrator talks to people.",
    tags: ["communication", "psychology", "everyday psychology", "conversation", "habits"],
    primary_keyword: "better communication",
    rationale: "Search-friendly phrasing of the same promise.",
  },
  confidence: { overall: 0.8, searchability: 0.8, honesty: 0.8, package_fidelity: 0.8 },
};

async function runSeo(storyProducer: string, title: string | undefined) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-seo-")), registry);
  const provider = new FakeProvider(() => seoResponse);
  const runner = new Runner({
    store, registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider, reasoning_script: provider }),
    runLog: new MemoryRunLog(),
    logger: { log() {}, warn() {}, error() {} },
    blobs: new MemoryBlobStore(),
  });
  const episode = buildManualEpisode({ ...(title ? { title } : {}), hook: "A stranger said one sentence to me. It changed everything.", narration: NARRATION });
  const producedBy = { transformation: storyProducer, version: "1", run_id: "r", provider: null };
  const story = await store.put({ schema_id: "story", payload: episode.story, produced_by: producedBy });
  const script = await store.put({ schema_id: "script", payload: episode.script, produced_by: producedBy });
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  const out = await runner.run(agents.get("seo_optimizer")!, [story.artifact.artifact_id, script.artifact.artifact_id]);
  return out.artifact.payload as { title: string; description: string; tags: string[] };
}

test("an editor's title reaches YouTube verbatim even when the SEO model rewrites it", async () => {
  const seo = await runSeo("human", EDITOR_TITLE);
  assert.equal(seo.title, EDITOR_TITLE);
  // Everything else is still the SEO model's work.
  assert.equal(seo.description, seoResponse.payload.description);
  assert.deepEqual(seo.tags, seoResponse.payload.tags);
});

test("a generated story's SEO title is left to the model", () => {
  const out = lockHumanAuthoredTitle(seoResponse.payload, { payload: { title: EDITOR_TITLE }, produced_by: { transformation: "narrative_story_architect" } });
  assert.equal((out as { title: string }).title, seoResponse.payload.title);
});

test("with no story, or no usable title, the payload is untouched", () => {
  assert.equal(lockHumanAuthoredTitle(seoResponse.payload, undefined), seoResponse.payload);
  assert.equal(lockHumanAuthoredTitle(seoResponse.payload, { payload: { title: "  " }, produced_by: { transformation: "human" } }), seoResponse.payload);
});
