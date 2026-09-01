const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

const compose = fs.readFileSync(path.join(__dirname, "../compose.js"), "utf8");

// The specs are pulled OUT of compose.js rather than duplicated here. A test
// that hardcodes its own copy of a filter string proves that string works,
// not that the shipped one does -- and the failure this guards against is
// precisely someone editing a spec into something ffmpeg rejects, which
// fails filtergraph parsing and takes the whole render with it.
function specFromSource(name) {
  const match = compose.match(new RegExp(`const ${name} = "([^"]+)";`));
  assert.ok(match, `compose.js no longer defines ${name}`);
  return match[1];
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio-mix-test-"));
const out = (name) => path.join(tmp, name);

function ffmpeg(args) {
  return execFileSync(ffmpegPath, ["-y", "-v", "error", ...args], { encoding: "utf8", timeout: 120000 });
}

function tone(file, freq, seconds, gain = 1) {
  const args = ["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}:sample_rate=44100`];
  if (gain !== 1) args.push("-af", `volume=${gain}`);
  ffmpeg([...args, file]);
  return file;
}

// Reads a mono 16-bit WAV without pulling in a dependency.
//
// This walks the RIFF chunk list to find `data` rather than assuming the
// canonical 44-byte header. Not pedantry: ffmpeg emits an extra LIST/INFO
// chunk on some invocations, and reading from a fixed offset then
// interprets header bytes as audio -- which produced a peak of 0.80 for a
// bed whose real peak is 0.011, i.e. a completely fabricated measurement in
// a test whose entire job is measuring levels.
function samples(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF", `${file} is not a RIFF file`);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      const body = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + size));
      const values = new Array(Math.floor(body.length / 2));
      for (let i = 0; i < values.length; i++) values[i] = body.readInt16LE(i * 2) / 32768;
      return values;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

function peak(values, fromSec = 0, toSec = Infinity) {
  const sr = 44100;
  const slice = values.slice(Math.floor(fromSec * sr), Math.min(values.length, Math.floor(toSec * sr)));
  return slice.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function rms(values, fromSec, toSec) {
  const sr = 44100;
  const slice = values.slice(Math.floor(fromSec * sr), Math.floor(toSec * sr));
  return Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
}

test("every audio filter the mix depends on parses in the shipped ffmpeg", () => {
  const limiter = specFromSource("LIMITER_SPEC");
  const sidechain = specFromSource("SIDECHAIN_SPEC");
  const ambientSource = specFromSource("AMBIENT_SOURCE");
  const ambientSpec = specFromSource("AMBIENT_SPEC");
  const silence = ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.1"];

  ffmpeg([...silence, "-af", limiter, "-f", "null", "-"]);
  ffmpeg([...silence, ...silence, "-filter_complex", `[0:a][1:a]${sidechain}[o]`, "-map", "[o]", "-f", "null", "-"]);
  ffmpeg(["-f", "lavfi", "-i", ambientSource, "-t", "0.1", "-af", ambientSpec, "-f", "null", "-"]);
});

test("the output limiter stops the summed mix bus from clipping", () => {
  // amix runs with normalize=0, which SUMS. Voice plus a bed plus up to 22
  // cues can exceed full scale, and the result is audible crackle on exactly
  // the loudest moments of the episode.
  const a = tone(out("hot-a.wav"), 300, 2, 6);
  const b = tone(out("hot-b.wav"), 305, 2, 6);
  const mix = "[0:a][1:a]amix=inputs=2:duration=first:normalize=0";

  ffmpeg(["-i", a, "-i", b, "-filter_complex", `${mix}[o]`, "-map", "[o]", "-c:a", "pcm_s16le", out("nolimit.wav")]);
  ffmpeg(["-i", a, "-i", b, "-filter_complex", `${mix},${specFromSource("LIMITER_SPEC")}[o]`, "-map", "[o]", "-c:a", "pcm_s16le", out("limit.wav")]);

  const unlimited = samples(out("nolimit.wav"));
  const limited = samples(out("limit.wav"));
  const clipped = unlimited.filter((value) => Math.abs(value) >= 0.9999).length;
  assert.ok(clipped / unlimited.length > 0.05, `expected the unlimited sum to clip, got ${clipped} clipped samples`);
  assert.ok(peak(limited) <= 0.9401, `limited peak ${peak(limited)} exceeded the configured ceiling`);
  assert.equal(limited.filter((value) => Math.abs(value) >= 0.9999).length, 0);
});

test("ducking the SFX bus measurably lowers a cue that lands under speech", () => {
  // Cues used to be summed straight into the final mix at a fixed gain, so
  // one landing mid-word competed with the narration at full level.
  const voice = tone(out("voice.wav"), 220, 3);
  const cue = tone(out("cue.wav"), 1800, 0.2);
  const bus = "[1:a]volume=0.5,adelay=1000|1000[sfx0]";

  ffmpeg(["-i", voice, "-i", cue, "-filter_complex", `${bus};[sfx0][0:a]${specFromSource("SIDECHAIN_SPEC")}[o]`, "-map", "[o]", "-c:a", "pcm_s16le", out("cue-ducked.wav")]);
  ffmpeg(["-i", voice, "-i", cue, "-filter_complex", `${bus};[sfx0]acopy[o]`, "-map", "[o]", "-c:a", "pcm_s16le", out("cue-plain.wav")]);

  const ducked = peak(samples(out("cue-ducked.wav")), 1.0, 1.25);
  const plain = peak(samples(out("cue-plain.wav")), 1.0, 1.25);
  assert.ok(plain > 0, "the unducked cue should be audible");
  const attenuationDb = 20 * Math.log10(ducked / plain);
  // Enough to sit behind the narration, not so much the cue disappears --
  // a cue that is inaudible is the same as no sound design at all.
  assert.ok(attenuationDb < -2, `expected real attenuation under speech, got ${attenuationDb.toFixed(2)} dB`);
  assert.ok(attenuationDb > -18, `cue was buried rather than ducked: ${attenuationDb.toFixed(2)} dB`);
});

test("a comma-escaped volume expression applies the authored per-span gains", () => {
  // The music bed is stepped per scene with a `volume` expression embedded in
  // a filtergraph, where a bare comma separates filters -- so every comma in
  // between(t,a,b) has to be escaped. Get that wrong and the graph silently
  // splits, which is why this is checked against a real render rather than by
  // eyeballing the string.
  const source = tone(out("env-src.wav"), 440, 6);
  const expression = "if(between(t\\,0\\,2)\\,0.10\\,if(between(t\\,2\\,4)\\,0.90\\,0.40))";
  ffmpeg(["-i", source, "-filter_complex", `[0:a]volume=volume='${expression}':eval=frame[o]`, "-map", "[o]", "-c:a", "pcm_s16le", out("env.wav")]);

  const values = samples(out("env.wav"));
  const quiet = rms(values, 0.2, 1.8);
  const loud = rms(values, 2.2, 3.8);
  const mid = rms(values, 4.2, 5.8);
  // Ratios, not absolutes: lavfi's sine is not full scale, and the claim
  // under test is that each span got ITS authored gain.
  assert.ok(Math.abs(loud / quiet - 9) < 0.5, `expected a 9x step, got ${(loud / quiet).toFixed(2)}`);
  assert.ok(Math.abs(mid / quiet - 4) < 0.4, `expected a 4x step, got ${(mid / quiet).toFixed(2)}`);
});

test("the music bed is shaped by visual state instead of one constant", () => {
  const table = compose.match(/const MUSIC_STATE_GAIN = \{[^}]+\}/);
  assert.ok(table, "compose.js no longer defines MUSIC_STATE_GAIN");
  const gains = Object.fromEntries([...table[0].matchAll(/(\w+):\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  // The whole point of the table: the bed gets out of the way of the densest
  // explanatory passages and lifts for the landing. A table where everything
  // is 1.0 would pass a "table exists" check while changing nothing.
  assert.ok(gains.mechanism < 1, "the bed must drop under the scenes carrying the explanation");
  assert.ok(gains.payoff > 1, "the bed must lift for the payoff");
  assert.ok(gains.payoff > gains.mechanism);
  assert.match(compose, /volume=volume='\$\{musicExpression\}':eval=frame/);
});

test("capabilities are probed by running the filter, not by trusting its name", () => {
  // A name-only check (see hasDrawtext) proves a filter exists but not that
  // the options passed to it parse -- and a bad option fails the graph just
  // as hard as a missing filter.
  const probe = compose.slice(compose.indexOf("async function supportsFfmpegArgs"), compose.indexOf("const LIMITER_SPEC"));
  assert.match(probe, /await execFileAsync\(ffmpegPath, args/);
  assert.match(probe, /_audioFilterSupport\.set\(key, ok\)/, "probe results must be cached, not re-run per render");
});

test("an unsupported filter degrades the mix rather than failing the render", () => {
  // Reduced-filter ffmpeg builds are real: Remotion ships one compiled with
  // --disable-filters that has neither sidechaincompress nor alimiter.
  assert.match(compose, /if \(canSidechain\) \{[\s\S]*?mixLabels\.push\("duckedmusic"\);[\s\S]*?\} else \{[\s\S]*?mixLabels\.push\("music"\);/);
  assert.match(compose, /if \(sfxLabels\.length > 0 && canSidechain\)[\s\S]*?\} else \{\s*mixLabels\.push\(\.\.\.sfxLabels\);/);
  assert.match(compose, /const limiter = canLimit \? `,\$\{LIMITER_SPEC\}` : "";/);
});

test("the ambient bed fills silence only when there is no music at all", () => {
  // Layering a noise floor under music buys nothing audible and risks
  // reading as hiss; filling an otherwise silent bed is a clear win.
  //
  // Currently force-disabled (`false &&` prefix) by operator decision, not
  // removed: real user report of "weird and noisy" audio, confirmed as a
  // constant background hiss. The sidechain ducking only attenuates this
  // bed WHILE the voice is speaking, so it plays at full designed volume
  // in every gap between lines -- exactly where a listener notices it. The
  // machinery below (generation, wiring, lavfi handling) is untouched and
  // still exercised by these tests so it stays correct for whenever this
  // is retuned and re-enabled.
  assert.match(compose, /const useAmbientBed = false && !hasMusic && explanationMode && await supportsAmbientBed\(\);/);
  assert.match(compose, /\} else if \(ambientIdx !== null\) \{/);
  // Generated from lavfi rather than shipped: no repo weight, and no
  // licensing question in a monetised video.
  //
  // Rendered to a FILE by a raw ffmpeg call, then added as an ordinary input.
  // lavfi must never reach fluent-ffmpeg: its capability check reads `-f` off
  // every input and requires that format to appear in `ffmpeg -formats` with
  // canDemux (lib/capabilities.js), and lavfi is a DEVICE listed under
  // `-devices`. Both .inputFormat("lavfi") and .inputOptions(["-f","lavfi"])
  // therefore fail on a build that lists it only as a device -- which the
  // production image does, while the local one does not. Two CI runs to find.
  assert.match(compose, /"-f", "lavfi", "-i", AMBIENT_SOURCE,/);
  assert.match(compose, /if \(ambientPath\) finalCmd\.input\(ambientPath\);/);
  const ambientBlock = compose.slice(
    compose.indexOf("let ambientPath = null;"),
    compose.indexOf("if (ambientPath) finalCmd.input(ambientPath);"),
  );
  assert.ok(ambientBlock.length > 0, "the ambient generation block moved");
  assert.doesNotMatch(ambientBlock, /finalCmd\.input/,
    "lavfi must not be handed to fluent-ffmpeg -- its capability check rejects device-only formats");
});

test("the generated ambient bed is audible but sits well under narration", () => {
  // The CI failure this replaces was a mismatch between the probe and the
  // render: the probe validated raw `-f lavfi -i <source>` and passed, while
  // the render went through fluent-ffmpeg, whose stricter check rejected it.
  // A probe that validates something other than what actually runs is worse
  // than no probe -- it reports a capability the render cannot use. Both take
  // the raw path now, which is exactly what this exercises.
  const source = specFromSource("AMBIENT_SOURCE");
  const spec = specFromSource("AMBIENT_SPEC");
  const rendered = out("ambient.wav");
  ffmpeg(["-f", "lavfi", "-i", source, "-t", "1", "-af", spec, "-c:a", "pcm_s16le", rendered]);

  const values = samples(rendered);
  assert.ok(values.length > 0, "the ambient bed produced no audio");
  // A bed you cannot hear is pointless; one you notice is hiss.
  const level = peak(values);
  assert.ok(level > 0.0005, `ambient bed is effectively silent (peak ${level})`);
  assert.ok(level < 0.2, `ambient bed is too loud to sit under narration (peak ${level})`);
});

test("the SFX bus is mixed with duration=longest so late cues survive", () => {
  // Each cue is offset by its own adelay. `duration=first` would truncate the
  // bus at the earliest cue and silently drop every later one.
  assert.match(compose, /amix=inputs=\$\{sfxLabels\.length\}:duration=longest:normalize=0\[sfxbus\]/);
});
