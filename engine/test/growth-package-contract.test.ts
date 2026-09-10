import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { agentSemanticValidationErrors, HARD_ERROR_PREFIX } from "../src/agent-validators.ts";
import {
  PACKAGE_CONTRACT_MARKER,
  repairGrowthPackageSelection,
  validateGrowthPackageReleaseability,
  validateGrowthPackageSelection,
} from "../src/growth-package-contract.ts";
import { makeGrowthPackageReleaseWorker } from "../src/workers/growth-package-release.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function packagePayload() {
  return {
    premise: "A hotel guest discovers why a fire alarm keeps sounding in the middle of the night.",
    target_audience: "Adults who enjoy contained mystery dramas",
    curiosity_gap: "Why the alarm keeps sounding when nobody can find a fire",
    emotional_engine: "confusion to suspicion to a concrete hidden cause",
    selected_title: "Wrong duplicated title",
    selected_title_family: "curiosity",
    selected_thumbnail_concept: "Wrong duplicated thumbnail concept",
    selected_thumbnail_family: "reversal",
    opening_visual: "A sleepy hotel guest standing beneath a flashing alarm in an otherwise calm corridor.",
    opening_line: "The alarm went off again, but this time there was no smoke anywhere.",
    first_30_seconds: {
      promise: "The episode will reveal what is really triggering the repeated alarm.",
      zero_to_five: "Open on the third unexplained alarm while guests spill into the corridor.",
      five_to_fifteen: "Staff reset the system, but one sensor immediately reports the same fault again.",
      fifteen_to_thirty: "A maintenance worker notices the alarm only returns after one specific room changes temperature.",
    },
    variants: [
      {
        family: "curiosity",
        title: "Why Did the Hotel Alarm Keep Going Off?",
        thumbnail_concept: "Confused guest under a flashing alarm in an empty corridor",
        click_reason: "The repeated alarm creates a concrete unanswered question.",
      },
      {
        family: "conflict",
        title: "The Hotel Said There Was No Fire",
        thumbnail_concept: "Guest confronting a dismissive night manager beside the alarm panel",
        click_reason: "The official explanation conflicts with what the guest keeps experiencing.",
      },
      {
        family: "reversal",
        title: "The Fire Alarm Was Warning Them About Something Else",
        thumbnail_concept: "Maintenance worker finding a hidden fault behind a hotel wall panel",
        click_reason: "The apparent false alarm becomes evidence of a different hidden problem.",
      },
    ],
    scores: { clickability: 0.88, story_potential: 0.86, audience_size: 0.84 },
    selection_rationale: "The curiosity title with the reversal thumbnail creates the strongest coherent open loop.",
    next_video_bridge: "Another hotel mystery began with a door that unlocked itself only after midnight.",
  };
}

test("family choice is authoritative and duplicated selected strings are canonicalized deterministically", () => {
  const broken = packagePayload();
  assert.deepEqual(validateGrowthPackageSelection(broken), [
    "selected title does not exactly match the curiosity variant",
    "selected thumbnail does not exactly match the reversal variant",
  ]);

  const { data, repairs } = repairGrowthPackageSelection(broken);
  const repaired = data as ReturnType<typeof packagePayload>;

  assert.deepEqual(repairs.map((repair) => repair.path), ["selected_title", "selected_thumbnail_concept"]);
  assert.equal(repaired.selected_title, broken.variants[0]!.title);
  assert.equal(repaired.selected_thumbnail_concept, broken.variants[2]!.thumbnail_concept);
  assert.equal(repaired.selected_title_family, "curiosity");
  assert.equal(repaired.selected_thumbnail_family, "reversal");
  assert.deepEqual(validateGrowthPackageSelection(repaired), []);
  assert.equal(broken.selected_title, "Wrong duplicated title");
  assert.equal(broken.selected_thumbnail_concept, "Wrong duplicated thumbnail concept");
});

test("growth_packager semantic validation accepts repairable drift without mutating provider output", () => {
  const payload = packagePayload();
  const before = structuredClone(payload);
  const errors = agentSemanticValidationErrors(
    { name: "growth_packager" } as never,
    payload,
    {},
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(validateGrowthPackageReleaseability(payload), []);
  assert.deepEqual(payload, before, "semantic preflight must preserve the raw agent artifact");
});

test("unrepairable package relationship remains a hard semantic error", () => {
  const payload = packagePayload();
  payload.variants[0]!.title = undefined as unknown as string;
  const errors = agentSemanticValidationErrors(
    { name: "growth_packager" } as never,
    payload,
    {},
  );

  assert.ok(errors.some((error) => error.startsWith(HARD_ERROR_PREFIX)));
  assert.ok(errors.some((error) => error.includes("selected title does not exactly match the curiosity variant")));
});

test("package_release repairs a schema-valid mismatch without mutating its parent artifact payload", async () => {
  const payload = packagePayload();
  const before = structuredClone(payload);
  const warnings: string[] = [];
  const worker = makeGrowthPackageReleaseWorker();
  const output = await worker.execute(
    { package: { payload } as never },
    {
      logger: { log: () => {}, warn: (message: string) => warnings.push(message), error: () => {} },
      blobs: {} as never,
      media: {},
      attemptNumber: 1,
      progress: async () => {},
    },
  );
  const released = output.payload as ReturnType<typeof packagePayload>;

  assert.deepEqual(validateGrowthPackageSelection(released), []);
  assert.equal(released.selected_title, released.variants[0]!.title);
  assert.equal(released.selected_thumbnail_concept, released.variants[2]!.thumbnail_concept);
  assert.deepEqual(payload, before, "release must create a new payload instead of rewriting its parent");
  assert.equal(warnings.length, 1);
});

test("illustrated story graph routes every package consumer through package_release", async () => {
  const graph = JSON.parse(await readFile(path.join(ROOT, "graphs", "illustrated_story.json"), "utf8")) as {
    version: string;
    nodes: Array<{ id: string; transformation?: string; in?: string[] }>;
  };
  const release = graph.nodes.find((node) => node.id === "package_release");
  assert.equal(graph.version, "10");
  assert.equal(release?.transformation, "growth_package_release");
  assert.deepEqual(release?.in, ["package"]);

  const consumers = [
    "story",
    "draft_script",
    "watchability_report",
    "watchability_release",
    "seo",
    "thumbnail_brief",
    "render",
  ];
  for (const id of consumers) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    assert.ok(node?.in?.includes("package_release"), `${id} must consume the released package`);
    assert.equal(node?.in?.includes("package"), false, `${id} must not consume the raw package`);
  }
});

test("watchability summary prompt stays comfortably below the 800-character schema ceiling", async () => {
  const prompt = await readFile(path.join(ROOT, "prompts", "watchability_critic", "4.md"), "utf8");
  assert.match(prompt, /NEVER exceed 600 characters/);
  const schema = JSON.parse(await readFile(path.join(ROOT, "schemas", "watchability_report", "2.0.0.json"), "utf8")) as {
    json_schema: { properties: { summary: { maxLength: number } } };
  };
  assert.equal(schema.json_schema.properties.summary.maxLength, 800);
});

test("package contract marker stays stable for operator diagnostics", () => {
  assert.equal(PACKAGE_CONTRACT_MARKER, "PACKAGE_CONTRACT");
});
