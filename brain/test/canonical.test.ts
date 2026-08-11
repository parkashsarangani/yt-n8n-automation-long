import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, canonicalHash, CanonicalizationError } from "../src/canonical.ts";

// Unicode fixtures use explicit escapes: two visually identical literals in
// source would make these tests silently vacuous.
const E_PRECOMPOSED = "café"; // café  (U+00E9)
const E_DECOMPOSED = "café"; // café  (e + U+0301 combining acute)

test("sorts object keys by UTF-16 code unit, not JS property order", () => {
  // The trap: JS orders integer-like keys numerically ahead of string keys,
  // so Object.keys gives ["9","10"] while JCS requires ["10","9"] ("1" < "9").
  // A naive implementation that relies on object insertion order fails here.
  const input = { "9": "nine", "10": "ten", b: 2, a: 1 };
  assert.deepEqual(Object.keys(input), ["9", "10", "b", "a"]); // JS order, for contrast
  assert.equal(canonicalize(input), '{"10":"ten","9":"nine","a":1,"b":2}');
});

test("key order in the source object does not affect output", () => {
  const a = { z: 1, m: { q: [1, 2], b: true }, a: "x" };
  const b = { a: "x", m: { b: true, q: [1, 2] }, z: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalHash(a), canonicalHash(b));
});

test("arrays preserve order (they are sequences, not sets)", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
});

test("numbers use ECMAScript Number::toString", () => {
  assert.equal(canonicalize(4.5), "4.5");
  assert.equal(canonicalize(0.002), "0.002");
  assert.equal(canonicalize(1e30), "1e+30");
  assert.equal(canonicalize(1e-27), "1e-27");
  assert.equal(canonicalize(100), "100");
  // -0 and 0 must not produce different artifact ids.
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalHash({ v: -0 }), canonicalHash({ v: 0 }));
});

test("rejects values that cannot round-trip through JSON", () => {
  assert.throws(() => canonicalize(NaN), CanonicalizationError);
  assert.throws(() => canonicalize(Infinity), CanonicalizationError);
  assert.throws(() => canonicalize({ v: 1n }), CanonicalizationError);
  // JSON.stringify would substitute null here; silently altering a hash is worse
  // than failing, so these throw.
  assert.throws(() => canonicalize([undefined]), CanonicalizationError);
  assert.throws(() => canonicalize([() => 1]), CanonicalizationError);
  assert.throws(() => canonicalize([Symbol("s")]), CanonicalizationError);
});

test("drops undefined object properties, matching JSON round-trip", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalHash({ a: 1, b: undefined }), canonicalHash({ a: 1 }));
});

test("detects circular references instead of hanging", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  assert.throws(() => canonicalize(cyclic), CanonicalizationError);
});

test("repeats a shared (non-circular) reference rather than failing", () => {
  const shared = { x: 1 };
  assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

test("normalizes strings to NFC so equivalent text hashes equally", () => {
  assert.notEqual(E_PRECOMPOSED, E_DECOMPOSED); // genuinely different code points
  assert.equal(canonicalize(E_PRECOMPOSED), canonicalize(E_DECOMPOSED));
  assert.equal(canonicalHash({ t: E_PRECOMPOSED }), canonicalHash({ t: E_DECOMPOSED }));
});

test("throws when two keys collide after NFC normalization", () => {
  // Built programmatically: as an object literal these would be one key, and
  // silently dropping one would change the hash for an invisible reason.
  const collide: Record<string, unknown> = {};
  collide[E_PRECOMPOSED] = 1;
  collide[E_DECOMPOSED] = 2;
  assert.equal(Object.keys(collide).length, 2);
  assert.throws(() => canonicalize(collide), CanonicalizationError);
});

test("escapes strings with the shortest legal form", () => {
  assert.equal(canonicalize("a\nb"), '"a\\nb"');
  assert.equal(canonicalize("tab\there"), '"tab\\there"');
  assert.equal(canonicalize('quote"and\\slash'), '"quote\\"and\\\\slash"');
  assert.equal(canonicalize(""), '"\\u0007"'); // C0 control with no short form
  assert.equal(canonicalize(""), '"\\u001f"');
  assert.equal(canonicalize("/"), '"/"'); // solidus is not escaped
  assert.equal(canonicalize("€"), '"€"'); // non-ASCII stays literal
});

test("honours toJSON, so Date becomes its ISO string", () => {
  const d = new Date("2026-08-10T09:12:44.000Z");
  assert.equal(canonicalize({ at: d }), '{"at":"2026-08-10T09:12:44.000Z"}');
});

test("nested structures canonicalize recursively", () => {
  const input = { b: [{ z: 1, a: 2 }], a: { d: null, c: false } };
  assert.equal(canonicalize(input), '{"a":{"c":false,"d":null},"b":[{"a":2,"z":1}]}');
});

test("hash is stable across calls and sensitive to any content change", () => {
  const doc = { title: "Chile", acts: [{ i: 0, t: "why so long" }] };
  assert.equal(canonicalHash(doc), canonicalHash(structuredClone(doc)));
  assert.notEqual(canonicalHash(doc), canonicalHash({ ...doc, title: "chile" }));
  assert.match(canonicalHash(doc), /^[0-9a-f]{64}$/);
});

test("REGRESSION GUARD: canonical form of a fixed document must never change", () => {
  // If this fails, the canonicalization algorithm changed and every artifact id
  // in existence is invalidated. That is a migration, not a test update.
  // TODO: add the official RFC 8785 conformance vectors; these are locally
  // derived regression anchors, not an external conformance claim.
  const doc = {
    literals: [null, true, false],
    numbers: [4.5, 0.002, 1e30],
    text: `${E_DECOMPOSED}/"x\\`,
    nested: { b: 1, a: [{ "10": 1, "9": 2 }] },
  };
  assert.equal(
    canonicalize(doc),
    '{"literals":[null,true,false],' +
      '"nested":{"a":[{"10":1,"9":2}],"b":1},' +
      '"numbers":[4.5,0.002,1e+30],' +
      `"text":"${E_PRECOMPOSED}/\\"x\\\\"}`,
  );
});
