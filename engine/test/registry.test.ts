import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  SchemaRegistry,
  SchemaRegistryError,
  SchemaValidationError,
  type SchemaEntry,
} from "../src/registry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(HERE, "..", "schemas");

async function tempRegistry(entries: SchemaEntry[]): Promise<SchemaRegistry> {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-schemas-"));
  for (const e of entries) {
    await mkdir(path.join(dir, e.schema_id), { recursive: true });
    await writeFile(
      path.join(dir, e.schema_id, `${e.version}.json`),
      JSON.stringify(e, null, 2),
      "utf8",
    );
  }
  return SchemaRegistry.load(dir);
}

function entry(over: Partial<SchemaEntry> = {}): SchemaEntry {
  return {
    schema_id: "thing",
    version: "1.0.0",
    status: "active",
    json_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    },
    ...over,
  };
}

test("loads the real project schemas", async () => {
  const reg = await SchemaRegistry.load(SCHEMA_DIR);
  for (const id of ["intent", "story", "script", "visual_plan", "voice", "asset_manifest", "rendered_video", "published_episode"]) {
    assert.ok(reg.has(id), `expected schema "${id}"`);
  }
  // story and script each carry an additive minor bump (RFC 0007) that widens
  // produced_by to allow "human", for the manual-script flow. script's later
  // 1.2.0 adds optional speaker/emotion for cartoon-mode dialogue.
  assert.equal(reg.resolveVersion("story"), "1.2.0");
  assert.equal(reg.resolveVersion("script"), "1.4.0");
});

test("a valid story payload passes and an invalid one reports usable errors", async () => {
  const reg = await SchemaRegistry.load(SCHEMA_DIR);
  const good = {
    topic: "Why Chile is so incredibly long",
    title: "The Country That Refused To Stop",
    hook: "Chile is four thousand kilometres of coastline and almost no width.",
    acts: [
      { act_index: 0, act_title: "The shape", premise: "Establish the absurd geometry of it.", target_words: 300 },
      { act_index: 1, act_title: "The spine", premise: "The Andes decided the border long before people did.", target_words: 300 },
      { act_index: 2, act_title: "The reach", premise: "Conquest stretched it further than anyone planned.", target_words: 300 },
    ],
    payoff: "The shape is not an accident of politics but of rock.",
    outro_line: "Send this to the person who thinks maps are boring.",
  };
  assert.doesNotThrow(() => reg.validate("story", "1.0.0", good));

  try {
    reg.validate("story", "1.0.0", { ...good, acts: [] });
    assert.fail("expected validation to throw");
  } catch (err) {
    assert.ok(err instanceof SchemaValidationError);
    // Errors must be human-readable enough to feed back into an agent retry.
    assert.ok(err.errors.length > 0);
    assert.match(err.errors.join(" "), /acts/);
  }
});

test("resolveVersion prefers active, then highest semver", async () => {
  const reg = await tempRegistry([
    entry({ version: "1.0.0", status: "active" }),
    entry({ version: "1.3.0", status: "active" }),
    entry({ version: "2.0.0", status: "draft" }),
  ]);
  assert.equal(reg.resolveVersion("thing"), "1.3.0"); // highest active
  assert.equal(reg.resolveVersion("thing", "^2"), "2.0.0"); // draft satisfies an explicit range
  assert.equal(reg.resolveVersion("thing", "^1"), "1.3.0");
});

test("retired versions are never resolved and never validate", async () => {
  const reg = await tempRegistry([
    entry({ version: "1.0.0", status: "retired" }),
    entry({ version: "2.0.0", status: "active" }),
  ]);
  assert.equal(reg.resolveVersion("thing"), "2.0.0");
  assert.throws(() => reg.resolveVersion("thing", "^1"), SchemaRegistryError);
  assert.throws(() => reg.validate("thing", "1.0.0", { name: "x" }), SchemaRegistryError);
});

test("produced_by is an allowlist", async () => {
  const reg = await tempRegistry([entry({ produced_by: ["story_architect"] })]);
  assert.doesNotThrow(() => reg.assertProducer("thing", "1.0.0", "story_architect"));
  assert.throws(() => reg.assertProducer("thing", "1.0.0", "script_writer"), SchemaRegistryError);
});

test("assertCompatible enforces the consumer's declared range", async () => {
  const reg = await tempRegistry([entry({ version: "2.1.0" })]);
  assert.doesNotThrow(() => reg.assertCompatible("thing", "2.1.0", "^2"));
  assert.throws(() => reg.assertCompatible("thing", "2.1.0", "^1"), SchemaRegistryError);
});

test("rejects entries whose declared version disagrees with the filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-schemas-"));
  await mkdir(path.join(dir, "thing"), { recursive: true });
  await writeFile(
    path.join(dir, "thing", "1.0.0.json"),
    JSON.stringify(entry({ version: "9.9.9" })),
    "utf8",
  );
  await assert.rejects(() => SchemaRegistry.load(dir), SchemaRegistryError);
});

test("unknown schema ids fail loudly", async () => {
  const reg = await tempRegistry([entry()]);
  assert.throws(() => reg.resolveVersion("nope"), SchemaRegistryError);
  assert.throws(() => reg.jsonSchema("nope"), SchemaRegistryError);
});
