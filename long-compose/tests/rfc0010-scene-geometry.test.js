const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Same approach as label-lines.test.js / mechanism-chain-appear.test.js:
// extract the real function source and strip its TS annotations so a plain
// `node --test` run exercises the actual arithmetic. Both functions here pin
// bugs that are invisible to source-grepping and expensive to catch in a full
// Remotion render.
function loadFromSource(relPath, marker, header, rewrites) {
  // Normalise line endings: these files are checked out with CRLF on Windows,
  // and the closing-brace scan below is anchored to "\n}\n".
  const source = fs.readFileSync(path.join(__dirname, relPath), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `expected to find ${marker} in ${relPath}`);
  let body = source.slice(start);
  const end = body.indexOf("\n}\n");
  assert.ok(end > 0, `expected a closing brace for ${marker}`);
  body = body.slice(0, end + 2);
  for (const [from, to] of rewrites) body = body.replace(from, to);
  // eslint-disable-next-line no-new-func
  return new Function(`${header}\n${body}\nreturn ${marker.match(/function (\w+)/)[1]};`)();
}

const RFC = "../remotion/src/semantic/rfc0010/";

const entrance = loadFromSource(
  `${RFC}Rfc0010Scene.tsx`,
  "export function entrance(",
  "const ENTRANCE_START=0.1,ENTRANCE_DURATION=0.3,ENTRANCE_SETTLED=0.9;",
  [[/export function entrance\([^)]*\): number/, "function entrance(r, retained, index, count)"]],
);

test("a single marker actually reaches its value, and holds", () => {
  assert.equal(entrance(1, false, 0, 1), 1);
  assert.equal(entrance(0.9, false, 0, 1), 1, "must be settled well before the beat ends");
});

test("every marker arrives and holds, however many there are", () => {
  for (const count of [1, 2, 3, 4]) {
    for (let i = 0; i < count; i++) {
      assert.ok(
        entrance(0.9, false, i, count) > 0.999,
        `marker ${i} of ${count} must have arrived by 90% of the beat`,
      );
      assert.equal(entrance(1, false, i, count), 1, `marker ${i} of ${count} must hold at the end of the beat`);
    }
  }
});

test("markers arrive in order rather than all at once", () => {
  const midway = [0, 1, 2, 3].map((i) => entrance(0.3, false, i, 4));
  for (let i = 1; i < midway.length; i++) {
    assert.ok(midway[i] <= midway[i - 1], `marker ${i} should not lead marker ${i - 1}`);
  }
  assert.ok(midway[0] > midway[3], "the stagger should be visible partway through the beat");
});

test("a retained marker is drawn already-complete and never re-animates", () => {
  for (const r of [0, 0.25, 0.5, 1]) {
    assert.equal(entrance(r, true, 0, 3), 1);
    assert.equal(entrance(r, true, 2, 3), 1);
  }
});

test("nothing has started moving at the very first frame", () => {
  assert.equal(entrance(0, false, 0, 2), 0);
});

const wrapToWidth = loadFromSource(
  `${RFC}text-fit.ts`,
  "export function wrapToWidth(",
  "const AVG_GLYPH_RATIO=0.56;function textWidth(t,f){return t.length*f*AVG_GLYPH_RATIO}",
  [
    [/export function wrapToWidth\([^)]*\): string\[\]/, "function wrapToWidth(text, maxWidth, fontSize)"],
    [/const (lines|broken): string\[\] = \[\]/g, "const $1 = []"],
  ],
);

test("a long caption wraps instead of running off the frame", () => {
  const caption = "Electronic delivery finishes before the sender's physical journey does";
  const lines = wrapToWidth(caption, 1620, 62);
  assert.ok(lines.length > 1, "a caption this long must wrap");
  for (const line of lines) {
    assert.ok(line.length * 62 * 0.56 <= 1620, `"${line}" would overflow the safe area`);
  }
  assert.equal(lines.join(" "), caption, "wrapping must not drop or reorder words");
});

test("a short caption stays on one line", () => {
  assert.deepEqual(wrapToWidth("Same 20 km, two speeds", 1620, 62), ["Same 20 km, two speeds"]);
});

test("a single unbreakable token is hard-broken rather than allowed to overhang", () => {
  const lines = wrapToWidth("Supercalifragilisticexpialidocious", 200, 62);
  for (const line of lines) {
    assert.ok(line.length * 62 * 0.56 <= 200, `"${line}" would overflow`);
  }
});
