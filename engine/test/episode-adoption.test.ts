/**
 * Adoption exists to rescue episodes a human published by hand, which the
 * pipeline otherwise cannot measure. The danger is not failing to match --
 * it is matching WRONGLY: a mispaired episode attributes real retention to
 * the wrong script prompt, permanently, in the table meant to settle what
 * works. These tests mostly pin the refusals.
 *
 * The collision below is real: two runs from 2026-09-16 and 2026-09-14 both
 * carry the title "How I Got My Idea Back Without Burning Bridges".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { proposeAdoptions, normaliseTitle } from "../src/episode-adoption.ts";

const run = (id: string, title: string | null) => ({ run_id: id, title });
const vid = (id: string, title: string) => ({ video_id: id, title });

test("a uniquely-titled run pairs with its uniquely-titled video", () => {
  const proposal = proposeAdoptions(
    [run("run_a", "The Pause That Made My Friend Listen")],
    [vid("vidA", "The Pause That Made My Friend Listen")],
  );
  assert.deepEqual(proposal.pairs, [{
    run_id: "run_a", video_id: "vidA",
    title: "The Pause That Made My Friend Listen", matched_on: "unique_title",
  }]);
  assert.deepEqual(proposal.conflicts, []);
  assert.deepEqual(proposal.unmatched_runs, []);
  assert.deepEqual(proposal.unmatched_videos, []);
});

test("two runs sharing a title are never paired, even to distinct videos", () => {
  // The real case. Picking by date or by order would be a coin flip whose
  // wrongness is invisible afterwards.
  const proposal = proposeAdoptions(
    [run("run_60853207", "How I Got My Idea Back Without Burning Bridges"),
     run("run_d50d520f", "How I Got My Idea Back Without Burning Bridges")],
    [vid("vidX", "How I Got My Idea Back Without Burning Bridges"),
     vid("vidY", "How I Got My Idea Back Without Burning Bridges")],
  );
  assert.deepEqual(proposal.pairs, []);
  assert.equal(proposal.conflicts.length, 1);
  assert.deepEqual(proposal.conflicts[0]!.run_ids.sort(), ["run_60853207", "run_d50d520f"]);
  assert.deepEqual(proposal.conflicts[0]!.video_ids.sort(), ["vidX", "vidY"]);
  assert.match(proposal.conflicts[0]!.reason, /2 runs and 2 videos/);
});

test("two runs competing for one video is a conflict, not a first-come pairing", () => {
  const proposal = proposeAdoptions(
    [run("run_a", "Shared Title"), run("run_b", "Shared Title")],
    [vid("vidOnly", "Shared Title")],
  );
  assert.deepEqual(proposal.pairs, []);
  assert.match(proposal.conflicts[0]!.reason, /2 runs share this title, 1 video/);
});

test("one run matching two videos is a conflict", () => {
  // A re-upload, or the editor publishing twice. Either way, unresolvable.
  const proposal = proposeAdoptions(
    [run("run_a", "Duplicated Upload")],
    [vid("vid1", "Duplicated Upload"), vid("vid2", "Duplicated Upload")],
  );
  assert.deepEqual(proposal.pairs, []);
  assert.match(proposal.conflicts[0]!.reason, /2 videos share this title, 1 run/);
});

test("ambiguity on one title does not block a clean pairing on another", () => {
  const proposal = proposeAdoptions(
    [run("run_a", "Shared"), run("run_b", "Shared"), run("run_c", "Distinct One")],
    [vid("vid1", "Shared"), vid("vid2", "Distinct One")],
  );
  assert.deepEqual(proposal.pairs.map((p) => p.run_id), ["run_c"]);
  assert.equal(proposal.conflicts.length, 1);
});

test("titles differing only in case, spacing or punctuation style still match", () => {
  // The title makes a round trip through YouTube and a human editor.
  const proposal = proposeAdoptions(
    [run("run_a", "He Took Credit — In Front of Everyone")],
    [vid("vidA", "he took credit - in front  of everyone")],
  );
  assert.equal(proposal.pairs.length, 1);
  assert.equal(normaliseTitle("It’s Fine"), normaliseTitle("it's fine"));
});

test("a retitled video is left unmatched rather than guessed at", () => {
  // The editor renamed it. Better an operator resolves this than the system
  // pairing on a fuzzy similarity score.
  const proposal = proposeAdoptions(
    [run("run_a", "The Phrase That Stops Idea-Theft")],
    [vid("vidA", "Something The Editor Renamed Entirely")],
  );
  assert.deepEqual(proposal.pairs, []);
  assert.deepEqual(proposal.conflicts, []);
  assert.deepEqual(proposal.unmatched_runs, [{ run_id: "run_a", title: "The Phrase That Stops Idea-Theft" }]);
  assert.deepEqual(proposal.unmatched_videos, [{ video_id: "vidA", title: "Something The Editor Renamed Entirely" }]);
});

test("a run with no title is reported unmatched, never paired", () => {
  const proposal = proposeAdoptions([run("run_a", null)], [vid("vidA", "Anything")]);
  assert.deepEqual(proposal.pairs, []);
  assert.deepEqual(proposal.unmatched_runs, [{ run_id: "run_a", title: null }]);
});

test("every run and video lands in exactly one bucket", () => {
  // Totality matters: a run silently dropped from all four lists would look
  // like it had been dealt with.
  const runs = [run("r1", "A"), run("r2", "B"), run("r3", "B"), run("r4", null), run("r5", "Z")];
  const videos = [vid("v1", "A"), vid("v2", "B"), vid("v3", "Q")];
  const p = proposeAdoptions(runs, videos);

  const seenRuns = [
    ...p.pairs.map((x) => x.run_id),
    ...p.conflicts.flatMap((c) => c.run_ids),
    ...p.unmatched_runs.map((x) => x.run_id),
  ];
  const seenVideos = [
    ...p.pairs.map((x) => x.video_id),
    ...p.conflicts.flatMap((c) => c.video_ids),
    ...p.unmatched_videos.map((x) => x.video_id),
  ];
  assert.deepEqual(seenRuns.sort(), ["r1", "r2", "r3", "r4", "r5"]);
  assert.deepEqual(seenVideos.sort(), ["v1", "v2", "v3"]);
  assert.equal(new Set(seenRuns).size, seenRuns.length, "no run appears twice");
  assert.equal(new Set(seenVideos).size, seenVideos.length, "no video appears twice");
});

test("an empty channel proposes nothing and loses nothing", () => {
  const p = proposeAdoptions([run("r1", "A")], []);
  assert.deepEqual(p.pairs, []);
  assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.unmatched_runs, [{ run_id: "r1", title: "A" }]);
});
