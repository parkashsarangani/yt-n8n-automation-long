import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SchemaRegistry } from "../src/registry.ts";
import { FsArtifactStore } from "../src/store.ts";
import { buildPerformanceWindow, summarizeRetentionEvents } from "../src/performance-window.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let n = 1;

async function setup() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-lineage-")), registry);
  const put = async (schema_id: string, payload: unknown, producer: string, parents: string[] = []) =>
    (await store.put({
      schema_id,
      payload,
      parents,
      produced_by: { transformation: producer, version: "1", run_id: `run_lineage_${n++}`, provider: null },
    })).artifact;
  return { registry, store, put };
}

test("performance window keeps measured outcomes attached to the creative decisions that produced them", async () => {
  const { registry, store, put } = await setup();
  const intent = await put("intent", {
    brief: "An ignored mechanic sees a dangerous failure coming and becomes the only person able to stop the disaster.",
    target_duration_sec: 180,
    genre: "drama",
    image_style: "flat_comic_expressive",
  }, "human");

  const growth = await put("growth_package", {
    premise: "An ignored mechanic is mocked for a concrete warning, then the exact failure happens in public.",
    target_audience: "Adults who enjoy workplace underestimation and reversal stories",
    curiosity_gap: "Why the mechanic knew the machine was about to fail",
    emotional_engine: "injustice to anxiety to public vindication",
    selected_title: "His Boss Laughed at the Warning",
    selected_thumbnail_concept: "Boss laughing at the warning",
    opening_visual: "A mechanic points at a frayed drive belt while his supervisor waves him away and the machine keeps running.",
    opening_line: "He pointed at the belt twice. His boss laughed the second time.",
    first_30_seconds: {
      promise: "The ignored warning will fail in exactly the way he predicted.",
      zero_to_five: "Show the frayed belt and the dismissal immediately.",
      five_to_fifteen: "Escalate the machine noise while coworkers side with the boss.",
      fifteen_to_thirty: "Reveal the first physical sign that the mechanic was right.",
    },
    variants: [
      { family: "curiosity", title: "The Mechanic Nobody Listened To", thumbnail_concept: "Mechanic beside a frayed belt", click_reason: "The viewer wants to know what he noticed." },
      { family: "conflict", title: "His Boss Laughed at the Warning", thumbnail_concept: "Boss laughing at the warning", click_reason: "The interpersonal injustice is instantly legible." },
      { family: "reversal", title: "Then the Machine Finally Broke", thumbnail_concept: "Broken machine behind the ignored mechanic", click_reason: "The reversal promises visible consequence." }
    ],
    scores: { clickability: 0.82, story_potential: 0.88, audience_size: 0.76 },
    selection_rationale: "The conflict package makes the injustice legible before the click and sets up a concrete, visual reversal.",
    next_video_bridge: "Next: the cleaner who noticed what every engineer missed.",
  }, "growth_packager", [intent.artifact_id]);

  const story = await put("story", {
    topic: "The ignored mechanic who was right",
    title: "His Boss Laughed at the Warning",
    hook: "A frayed belt is screaming in plain sight, but the only man pointing at it is being laughed out of the room.",
    genre: "drama",
    acts: [
      { act_index: 0, act_title: "The Warning", premise: "The mechanic spots a concrete failure and is dismissed in front of his coworkers.", target_words: 90 },
      { act_index: 1, act_title: "The Breakdown", premise: "The warning becomes real and the room shifts from mockery to panic.", target_words: 110 },
      { act_index: 2, act_title: "The Reversal", premise: "The mechanic fixes what everyone else ignored and the social hierarchy visibly reverses.", target_words: 100 }
    ],
    payoff: "The same supervisor who laughed now has to ask the mechanic how to save the line.",
    outro_line: "Next: the cleaner who noticed what every engineer missed.",
    retention_beats: [
      { at_fraction: 0.2, device: "first visible belt failure" },
      { at_fraction: 0.62, device: "machine stops in front of the dismissive boss" }
    ]
  }, "narrative_story_architect", [intent.artifact_id, growth.artifact_id]);

  const seo = await put("seo_metadata", {
    title: "His Boss Laughed at the Warning",
    description: "A workplace reversal story about an ignored mechanic whose warning proves exactly right when the machine fails.",
    tags: ["workplace", "mechanic", "reversal", "story", "warning"],
    primary_keyword: "ignored mechanic warning",
    rationale: "The keyword names the central conflict without spoiling the reversal."
  }, "seo_optimizer", [story.artifact_id]);
  const thumbnail = await put("thumbnail", {
    thumbnail_uri: `blob://sha256:${"1".repeat(64)}`,
    media_type: "image/png",
    width: 1280,
    height: 720,
    text: "HE WARNED THEM",
    background: "supplied"
  }, "thumbnail", [growth.artifact_id]);
  const published = await put("published_episode", {
    target: "youtube",
    external_id: "creative-lineage-video",
    url: "https://www.youtube.com/watch?v=creative-lineage-video",
    title: "His Boss Laughed at the Warning",
    published_at: "2026-09-01T19:00:00.000Z"
  }, "publish", [story.artifact_id, seo.artifact_id, thumbnail.artifact_id]);

  await put("episode_performance", {
    external_id: "creative-lineage-video",
    source: "youtube-analytics",
    window: { start_date: "2026-09-01", end_date: "2026-09-03", days: 3 },
    measured_at: "2026-09-04T08:00:00.000Z",
    metrics: {
      views: 1400,
      estimated_minutes_watched: 4900,
      average_view_duration_sec: 210,
      average_view_percentage: 70,
      subscribers_gained: 18,
      likes: 91,
      comments: 14,
      shares: 11,
      impressions: 22000,
      click_through_rate: 0.071,
      retention_curve: [
        { elapsed_ratio: 0.02, audience_watch_ratio: 0.96 },
        { elapsed_ratio: 0.10, audience_watch_ratio: 0.88 },
        { elapsed_ratio: 0.20, audience_watch_ratio: 0.76 },
        { elapsed_ratio: 0.28, audience_watch_ratio: 0.83 },
        { elapsed_ratio: 0.62, audience_watch_ratio: 0.69 }
      ],
      retention_5s: 0.94,
      retention_15s: 0.88,
      retention_30s: 0.81,
      unavailable: []
    }
  }, "measure", [published.artifact_id]);

  const window = await buildPerformanceWindow(store, { now: () => new Date("2026-09-04T12:00:00.000Z") });
  const row = window.episodes[0]!;

  assert.equal(row.creative?.emotional_engine, "injustice to anxiety to public vindication");
  assert.equal(row.creative?.selected_title_family, "conflict");
  assert.equal(row.creative?.selected_thumbnail_family, "conflict");
  assert.match(row.creative?.first_30_seconds?.promise ?? "", /ignored warning/i);
  assert.match(row.creative?.story_hook ?? "", /frayed belt/i);
  assert.deepEqual(row.creative?.act_titles, ["The Warning", "The Breakdown", "The Reversal"]);
  assert.equal(row.creative?.image_style, "flat_comic_expressive");
  assert.equal(row.metrics.impressions, 22000);
  assert.equal(row.metrics.average_view_duration_sec, 210);
  assert.equal(row.metrics.shares, 11);
  assert.ok(row.metrics.retention_events.some((e) => e.kind === "dip" && e.elapsed_ratio === 0.2));
  assert.ok(row.metrics.retention_events.some((e) => e.kind === "spike" && e.elapsed_ratio === 0.28));
  assert.equal(window.aggregates.median_average_view_duration_sec, 210);
  assert.doesNotThrow(() => registry.validate("performance_window", "2.1.0", window));
});

test("retention event summarization is bounded and ignores tiny local noise", () => {
  const events = summarizeRetentionEvents([
    { elapsed_ratio: 0.01, audience_watch_ratio: 1.0 },
    { elapsed_ratio: 0.02, audience_watch_ratio: 0.99 },
    { elapsed_ratio: 0.10, audience_watch_ratio: 0.88 },
    { elapsed_ratio: 0.20, audience_watch_ratio: 0.92 },
    { elapsed_ratio: 0.30, audience_watch_ratio: 0.80 },
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.elapsed_ratio]), [["dip", 0.1], ["spike", 0.2], ["dip", 0.3]]);
});
