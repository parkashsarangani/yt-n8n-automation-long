/**
 * Automatic edit of a Short from its beat images (2026-10-10). The cut is
 * timed to the narration to the frame, captions follow the spoken words, and
 * the scheduler pass decides once per run who edits it ("ab" alternates),
 * never adds a second final cut, and hands the run back to the editor after
 * two failed renders.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { VidGenService } from "../src/service.ts";
import { isEditorCutFilename, isPipelineAuthoredFile } from "../src/workers/editor-package.ts";
import {
  AUTO_CUT_FILE, AUTO_EDIT_FAILED_NOTE_FILE, AUTO_EDIT_NOTE_FILE, FPS, FRAMINGS, SHOT_TARGET_SEC,
  audioArgs, autoEditMode, buildSegments, captionsAss, chunkWords, clipWords, mapBeatImages, planShots, shotArgs, zoompanFilter,
} from "../src/auto-edit.ts";
import type { BeatScene } from "../src/beat-images.ts";

const SCENES: BeatScene[] = [
  { scene_index: 0, narration: "You said yes again.", point: "Hook" },
  { scene_index: 1, narration: "Everyone thinks you are always available.", point: "Available" },
  { scene_index: 2, narration: "So the asks keep coming, one after another.", point: "Asks" },
  { scene_index: 3, narration: "Follow Quiet Signal for more.", is_outro: true },
];

test("AUTO_EDIT: off unless ab or all", () => {
  assert.equal(autoEditMode(undefined), "off");
  assert.equal(autoEditMode("AB"), "ab");
  assert.equal(autoEditMode(" all "), "all");
  assert.equal(autoEditMode("0"), "off");
  assert.equal(autoEditMode("yes please"), "off");
});

test("the auto cut is imported as a final cut; the notes are ours, never an editor upload", () => {
  assert.equal(isEditorCutFilename(AUTO_CUT_FILE), true);
  assert.equal(isPipelineAuthoredFile(AUTO_EDIT_NOTE_FILE), true);
  assert.equal(isPipelineAuthoredFile(AUTO_EDIT_FAILED_NOTE_FILE), true);
});

test("word timings come from the ElevenLabs character timing", () => {
  const text = "Say no.";
  const alignment = {
    characters: [..."Say no."],
    character_start_times_seconds: [0.1, 0.15, 0.2, 0.3, 0.5, 0.55, 0.6],
    character_end_times_seconds: [0.15, 0.2, 0.28, 0.5, 0.55, 0.6, 0.7],
  };
  assert.deepEqual(clipWords(text, 1, alignment), [
    { text: "Say", start: 0.1, end: 0.28 },
    { text: "no.", start: 0.5, end: 0.7 },
  ]);
});

test("without timing, words are spread over the clip by length", () => {
  const words = clipWords("a bb ccc", 9);
  assert.equal(words.length, 3);
  assert.equal(words[0]!.start, 0);
  assert.ok(Math.abs(words.at(-1)!.end - 9) < 1e-9);
  assert.ok(words[2]!.end - words[2]!.start > words[0]!.end - words[0]!.start);
});

test("shots cover the narration to the frame, cut about every 2.6 s, open on the hook", () => {
  const segments = buildSegments(SCENES, new Map([[0, 2.2], [1, 7.9], [2, 5.3], [3, 2.1]]), new Map([[0, 0], [1, 1], [2, 2]]));
  const shots = planShots(segments);
  const total = 2.2 + 7.9 + 5.3 + 2.1;
  assert.equal(shots.reduce((n, s) => n + s.frames, 0), Math.round(total * FPS), "no drift against the audio");
  shots.forEach((s, i) => { if (i > 0) assert.equal(s.startFrame, shots[i - 1]!.startFrame + shots[i - 1]!.frames, "contiguous"); });
  assert.equal(shots[0]!.framing.name, "hook");
  assert.equal(shots.filter((s) => s.scene_index === 1).length, Math.round(7.9 / SHOT_TARGET_SEC));
  assert.ok(shots.every((s) => s.frames / FPS < 4.5), "never a long still");
  assert.equal(shots.at(-1)!.framing.name, "pullOut");
});

test("the closing line goes back to the hook image; a beat without an image keeps the previous one", () => {
  const segments = buildSegments(SCENES, new Map([[0, 2], [1, 2], [2, 2], [3, 2]]), new Map([[0, 4], [1, 7]]));
  assert.deepEqual(segments.map((s) => s.image), [4, 7, 7, 4]);
});

test("beat images map to scenes by their NN prefix, whatever order Drive lists them", () => {
  const files = ["03-so-the-asks.png", "prompts.md", "01-hook.png"];
  assert.deepEqual([...mapBeatImages(SCENES, files).entries()].sort(), [[0, 2], [2, 0]]);
});

test("captions: up to 3 words, broken at punctuation, the spoken word highlighted", () => {
  const words = clipWords("You said yes. Again and again and again.", 4);
  const chunks = chunkWords(words);
  assert.deepEqual(chunks.map((c) => c.map((w) => w.text).join(" ")), ["You said yes.", "Again and again", "and again."]);
  const ass = captionsAss(words);
  assert.match(ass, /PlayResX: 1080/);
  const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(lines.length, words.length, "one event per spoken word");
  assert.match(lines[1]!, /YOU \{\\c&H0030B6F2&\}SAID\{\\c&H00FFFFFF&\} YES\./);
  assert.match(lines[0]!, /\\fscx70/, "a new caption pops in");
  assert.doesNotMatch(lines[1]!, /\\fscx70/, "the next word in it does not");
});

test("ffmpeg arguments: one exact-length shot, narration clips held to their durations", () => {
  const shot = { image: 0, startFrame: 0, frames: 78, framing: FRAMINGS["close"]!, scene_index: 1 };
  const args = shotArgs("/tmp/img.png", shot, "/tmp/out.mp4");
  assert.equal(args[args.indexOf("-frames:v") + 1], "78");
  assert.match(args[args.indexOf("-filter_complex") + 1]!, /zoompan=.*:d=78:s=1080x1080/);
  assert.match(zoompanFilter(FRAMINGS["hook"]!, 30), /pow\(1-\(on\/29\),3\)/, "the hook eases out");
  const audio = audioArgs([{ file: "a.mp3", duration: 2.5 }, { file: "b.mp3", duration: 1.25 }], "out.wav");
  assert.match(audio.join(" "), /atrim=0:2\.5000.*atrim=0:1\.2500.*concat=n=2:v=0:a=1/);
});

// ---------------------------------------------------------------- scheduler pass

interface Folder { [name: string]: { id: string; mimeType: string } }

function makeService(runIds: string[], opts: { existingCut?: boolean } = {}) {
  const service = Object.create(VidGenService.prototype);
  const records: Array<Record<string, unknown>> = [];
  const uploads: Array<{ folder: string; name: string }> = [];
  service.runLog = { record: async (r: Record<string, unknown>) => { records.push(r); } };
  service.runRecords = async (id: string) => records.filter((r) => r.run_id === id);
  // Every run already has its beat images.
  for (const id of runIds) records.push({ run_id: id, node_id: "beat_images", status: "ok", transformation: "beat_images", started_at: "2026-10-10T10:00:00Z" });
  service.listRuns = () => runIds.map((id, i) => ({
    run_id: id,
    created_at: new Date(Date.now() - (runIds.length - i) * 60_000).toISOString(),
    waiting: [{ node_id: "editor_review", artifact_id: `handoff-${id}`, reason: "" }],
    nodes: [{ node_id: "draft_script", artifact_id: "script" }, { node_id: "voice", artifact_id: "voice" }],
  }));
  service.store = {
    get: async (id: string) => {
      if (id.startsWith("handoff-")) return { payload: { drive_folder_id: `folder-${id.slice(8)}` } };
      if (id === "script") return { payload: { scenes: SCENES } };
      if (id === "voice") return { payload: { clips: SCENES.map((s) => ({ scene_index: s.scene_index, audio_uri: "blob://a", duration_sec: 2 })) } };
      return null;
    },
  };
  service.blobs = { get: async () => new Uint8Array([1]) };
  const folders = new Map<string, Folder>();
  service.driveProvider = {
    listFiles: async (folderId: string) => {
      if (folderId.startsWith("beats-")) return [{ id: "img1", name: "01-hook.png", mimeType: "image/png" }];
      const extra = opts.existingCut ? [{ id: "cut", name: "final.mp4", mimeType: "video/mp4" }] : [];
      return [{ id: `beats-${folderId}`, name: "beats", mimeType: "application/vnd.google-apps.folder" }, ...extra,
        ...Object.entries(folders.get(folderId) ?? {}).map(([name, f]) => ({ name, ...f }))];
    },
    downloadFile: async () => new Uint8Array([2]),
    uploadFile: async (folder: string, name: string) => {
      uploads.push({ folder, name });
      folders.set(folder, { ...(folders.get(folder) ?? {}), [name]: { id: name, mimeType: "x" } });
      return name;
    },
  };
  const render = async () => ({ video: new Uint8Array([9]), duration_sec: 8, shots: 4 });
  return { service, records, uploads, render };
}

test("ab alternates who edits, tells the editor, and uploads the auto cut", async () => {
  process.env["AUTO_EDIT"] = "ab";
  const { service, records, uploads, render } = makeService(["run_a", "run_b", "run_c"]);
  const result = await service.autoEditPending({ render });
  const sources = ["run_a", "run_b", "run_c"].map((id) => records.find((r) => r.run_id === id && r.node_id === "edit_source")?.transformation);
  assert.deepEqual(sources, ["auto", "editor", "auto"]);
  assert.equal(result.rendered, 2);
  assert.deepEqual(uploads.map((u) => `${u.folder}/${u.name}`).sort(), [
    `folder-run_a/${AUTO_EDIT_NOTE_FILE}`, `folder-run_a/${AUTO_CUT_FILE}`,
    `folder-run_c/${AUTO_EDIT_NOTE_FILE}`, `folder-run_c/${AUTO_CUT_FILE}`,
  ].sort());

  // A second pass decides nothing again and renders nothing again.
  const again = await service.autoEditPending({ render });
  assert.equal(again.rendered, 0);
  assert.equal(records.filter((r) => r.node_id === "edit_source").length, 3);
});

test("never adds a second final cut to a folder", async () => {
  process.env["AUTO_EDIT"] = "all";
  const { service, uploads, render } = makeService(["run_a"], { existingCut: true });
  const result = await service.autoEditPending({ render });
  assert.equal(result.rendered, 0);
  await service.autoEditPending({ render });
  assert.ok(!uploads.some((u) => u.name === AUTO_CUT_FILE));
  assert.ok(!uploads.some((u) => u.name === AUTO_EDIT_FAILED_NOTE_FILE), "stepping aside is not a failure");
});

test("after two failed renders the Short goes back to the editor, with a note", async () => {
  process.env["AUTO_EDIT"] = "all";
  let calls = 0;
  const { service, uploads } = makeService(["run_a"]);
  const failing = async () => { calls++; throw new Error("auto edit shot 1/4 failed: boom"); };
  await service.autoEditPending({ render: failing });
  assert.ok(!uploads.some((u) => u.name === AUTO_EDIT_FAILED_NOTE_FILE), "one failure is retried");
  await service.autoEditPending({ render: failing });
  assert.ok(uploads.some((u) => u.name === AUTO_EDIT_FAILED_NOTE_FILE));
  await service.autoEditPending({ render: failing });
  assert.equal(calls, 2, "never a third attempt");
});

test("off does nothing", async () => {
  process.env["AUTO_EDIT"] = "off";
  const { service, uploads, render } = makeService(["run_a"]);
  assert.deepEqual(await service.autoEditPending({ render }), { checked: 0, rendered: 0 });
  assert.equal(uploads.length, 0);
});
