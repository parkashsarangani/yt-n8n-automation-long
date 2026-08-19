from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "long-compose" / "compose.js"
QUALITY_TEST = ROOT / "long-compose" / "tests" / "output-quality.test.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} matches, found {count}")
    return text.replace(old, new)


def sub_once(text: str, pattern: str, replacement: str, label: str) -> str:
    out, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 regex match, found {count}")
    return out


compose = COMPOSE.read_text(encoding="utf-8")

# ---------------------------------------------------------------------------
# Process/runtime hardening
# ---------------------------------------------------------------------------
compose = replace_once(
    compose,
    'const KENBURNS_UPSCALE = Math.max(2200, parseInt(process.env.KENBURNS_UPSCALE || "3500", 10));\n',
    'const KENBURNS_UPSCALE = Math.max(2200, parseInt(process.env.KENBURNS_UPSCALE || "3500", 10));\n'
    'const DEBUG_KEEP_TMP = /^(1|true|yes)$/i.test(process.env.DEBUG_KEEP_TMP || "");\n'
    'const JOB_TTL_MS = Math.max(1000, Number(process.env.JOB_TTL_MS) || 2 * 60 * 60 * 1000);\n'
    'const JOB_SWEEP_INTERVAL_MS = Math.max(1000, Math.min(JOB_TTL_MS, Number(process.env.JOB_SWEEP_INTERVAL_MS) || 5 * 60 * 1000));\n\n'
    '// Completed/failed jobs used to live forever when a caller disappeared before polling.\n'
    '// Active renders are never expired; only terminal jobs older than JOB_TTL_MS are swept.\n'
    'const jobSweepTimer = setInterval(() => {\n'
    '  const now = Date.now();\n'
    '  for (const [id, job] of jobStore) {\n'
    '    if ((job.status === "done" || job.status === "failed") && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {\n'
    '      jobStore.delete(id);\n'
    '    }\n'
    '  }\n'
    '}, JOB_SWEEP_INTERVAL_MS);\n'
    'jobSweepTimer.unref?.();\n',
    "runtime config",
)
compose = replace_once(
    compose,
    '    if (!process.env.DEBUG_KEEP_TMP) {\n',
    '    if (!DEBUG_KEEP_TMP) {\n',
    "DEBUG_KEEP_TMP parsing",
)

# ---------------------------------------------------------------------------
# Thumbnail request isolation: remove process-global result metadata.
# ---------------------------------------------------------------------------
compose = replace_once(
    compose,
    '// Records which background was actually used, so callers can report a gradient\n'
    '// fallback rather than claiming the supplied image was applied. Read via\n'
    '// lastThumbnailBackground() immediately after the call.\n'
    'let _lastThumbnailBackground = "gradient";\n'
    'function lastThumbnailBackground() { return _lastThumbnailBackground; }\n\n'
    '// What the layout actually chose. Reported so the guideline checks — headline\n'
    '// legible at small size, text inside its column, right region proportion — can\n'
    '// be asserted downstream instead of eyeballed.\n'
    'let _lastThumbnailLayout = null;\n'
    'function lastThumbnailLayout() { return _lastThumbnailLayout; }\n\n',
    '// Thumbnail result metadata is returned from buildThumbnail() per request.\n'
    '// Do not store it in process globals: concurrent /thumbnail calls otherwise race.\n\n',
    "thumbnail globals",
)
compose = replace_once(compose, '  _lastThumbnailBackground = "gradient";\n', '  let thumbnailBackground = "gradient";\n', "thumbnail default background")
compose = replace_count(compose, '    _lastThumbnailBackground = "supplied";\n', '    thumbnailBackground = "supplied";\n', 2, "thumbnail supplied background")
compose = replace_once(compose, '  _lastThumbnailLayout = {\n', '  const layout = {\n', "thumbnail layout local")
compose = replace_once(
    compose,
    '  };\n  return outPath;\n}\n\n// ---------------------------------------------------------------------------\n// Studio Color Grading',
    '  };\n  return { path: outPath, background: thumbnailBackground, layout };\n}\n\n// ---------------------------------------------------------------------------\n// Studio Color Grading',
    "thumbnail structured return",
)

# ---------------------------------------------------------------------------
# Remotion child process: eliminate async Promise executor and guarantee cleanup.
# ---------------------------------------------------------------------------
new_render_remotion = r'''async function renderRemotion(compositionId, outputPath, durationSec, props) {
  const bridgePath = path.join(REMOTION_DIR, "render-bridge.mjs");

  // Write props to a temp file to avoid E2BIG when props contain large
  // base64 images. UUID keeps concurrent scene renders collision-free.
  const propsFile = path.join(path.dirname(outputPath), `props_${crypto.randomUUID()}.json`);
  await fsp.writeFile(propsFile, JSON.stringify(props));

  const args = [
    bridgePath,
    compositionId,
    outputPath,
    String(durationSec),
    `@${propsFile}`,
  ];

  console.log(`[remotion] Rendering ${compositionId} (${durationSec}s)...`);
  try {
    const { stdout, stderr } = await execFileAsync("node", args, {
      cwd: REMOTION_DIR,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout) console.log("[remotion stdout]", stdout);
    if (stderr) console.log("[remotion stderr]", stderr);
    return outputPath;
  } catch (err) {
    console.error("[remotion] Render failed:", err.message);
    throw err;
  } finally {
    await fsp.unlink(propsFile).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// AI Image'''
compose = sub_once(
    compose,
    r'function renderRemotion\(compositionId, outputPath, durationSec, props\) \{.*?\n\}\n\n// ---------------------------------------------------------------------------\n// AI Image',
    new_render_remotion,
    "renderRemotion",
)

# Temp render output must be unique under bounded concurrent template rendering.
compose = replace_once(
    compose,
    '  const templateVideoPath = path.join(tmpDir, `remotion_${compositionId}_${Date.now()}.mp4`);\n',
    '  const templateVideoPath = path.join(tmpDir, `remotion_${compositionId}_${crypto.randomUUID()}.mp4`);\n',
    "template output UUID",
)

# Avoid an unnecessary H.264 -> H.264 scene re-encode when Remotion already
# produced the requested duration. Only pad/re-encode if the render is short.
new_template_mux = r'''  // Mux template video with narration. Remotion already renders H.264 at the
  // target geometry/fps, so copy video directly whenever it is long enough.
  // Re-encode only when a short render actually needs tpad.
  const templateDuration = await ffprobeDuration(templateVideoPath);
  const needsPadding = templateDuration + 0.05 < duration;

  await runAudioMux((normalize) => {
    if (!needsPadding) {
      const opts = ["-map", "0:v", "-map", "1:a", "-t", String(duration)];
      if (normalize) opts.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
      opts.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k");
      return ffmpeg()
        .input(templateVideoPath)
        .input(audioPath)
        .outputOptions(opts)
        .output(outPath);
    }

    const padDuration = Math.max(0, duration - templateDuration + 0.1).toFixed(3);
    const videoFilter = `[0:v]tpad=stop_mode=clone:stop_duration=${padDuration}[padded]`;
    const opts = ["-map", "[padded]", "-map", "1:a", "-t", String(duration)];
    if (normalize) opts.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
    opts.push(
      "-c:v", V_ENCODER,
      "-r", String(FPS),
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
    );
    return ffmpeg()
      .input(templateVideoPath)
      .input(audioPath)
      .complexFilter([videoFilter])
      .outputOptions(opts)
      .output(outPath);
  });

  return outPath;
}

// ---------------------------------------------------------------------------
// Karaoke ASS'''
compose = sub_once(
    compose,
    r'  // Mux template video \(or composite\) with audio\n  const templateDuration = await ffprobeDuration\(templateVideoPath\);.*?\n  return outPath;\n\}\n\n// ---------------------------------------------------------------------------\n// Karaoke ASS',
    new_template_mux,
    "template mux",
)

# ---------------------------------------------------------------------------
# ASS/caption hardening.
# ---------------------------------------------------------------------------
to_ass_time = '''function toAssTime(sec) {\n  const h = Math.floor(sec / 3600);\n  const m = Math.floor((sec % 3600) / 60);\n  const s = (sec % 60).toFixed(2);\n  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}`;\n}\n'''
caption_helpers = to_ass_time + r'''

// User text must never be allowed to inject ASS override blocks. Replace the
// characters that carry ASS control syntax while preserving readable content.
function escapeAssText(value) {
  return String(value ?? "")
    .replace(/\\/g, "＼")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

function validatedAlignment(alignment, sceneIdx) {
  if (!alignment) return null;
  const rawChars = alignment.characters;
  const chars = Array.isArray(rawChars)
    ? rawChars
    : (typeof rawChars === "string" ? [...rawChars] : []);
  const starts = Array.isArray(alignment.character_start_times_seconds)
    ? alignment.character_start_times_seconds
    : [];
  const ends = Array.isArray(alignment.character_end_times_seconds)
    ? alignment.character_end_times_seconds
    : [];

  const length = Math.min(chars.length, starts.length, ends.length);
  if (!length) return null;
  if (chars.length !== starts.length || chars.length !== ends.length) {
    console.warn(
      `[captions] scene ${sceneIdx}: alignment length mismatch ` +
      `(chars=${chars.length}, starts=${starts.length}, ends=${ends.length}); truncating to ${length}`,
    );
  }

  const cleanChars = [];
  const cleanStarts = [];
  const cleanEnds = [];
  for (let i = 0; i < length; i++) {
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      console.warn(`[captions] scene ${sceneIdx}: dropping invalid alignment entry ${i}`);
      continue;
    }
    cleanChars.push(String(chars[i] ?? ""));
    cleanStarts.push(start);
    cleanEnds.push(end);
  }

  return cleanChars.length
    ? { characters: cleanChars, character_start_times_seconds: cleanStarts, character_end_times_seconds: cleanEnds }
    : null;
}
'''
compose = replace_once(compose, to_ass_time, caption_helpers, "caption helpers")
old_alignment = '''    const alignment = scene?.audio?.alignment;\n    if (!alignment) return;\n\n    const chars = alignment.characters;\n    const starts = alignment.character_start_times_seconds;\n    const ends = alignment.character_end_times_seconds;\n'''
new_alignment = '''    const alignment = validatedAlignment(scene?.audio?.alignment, sceneIdx);\n    if (!alignment) return;\n\n    const chars = alignment.characters;\n    const starts = alignment.character_start_times_seconds;\n    const ends = alignment.character_end_times_seconds;\n'''
compose = replace_count(compose, old_alignment, new_alignment, 2, "alignment validation")
compose = replace_once(
    compose,
    '        line += `{\\\\kf${wordDurationCs}}${word.text} `;\n',
    '        line += `{\\\\kf${wordDurationCs}}${escapeAssText(word.text)} `;\n',
    "ASS word escaping",
)
compose = replace_once(
    compose,
    '    const escaped = commentHook.replace(/\\\\/g, "").replace(/\\{/g, "").replace(/\\}/g, "");\n',
    '    const escaped = escapeAssText(commentHook);\n',
    "comment hook escaping",
)

# ---------------------------------------------------------------------------
# Outro normalization and inline-image animation guard.
# ---------------------------------------------------------------------------
main_marker = '// ---------------------------------------------------------------------------\n// Main Compose Pipeline\n// ---------------------------------------------------------------------------\n'
outro_helper = r'''function isOutroScene(scene) {
  const data = scene?.template_data;
  if (data && typeof data === "object") return data.is_outro === true;
  if (typeof data === "string") {
    try { return JSON.parse(data)?.is_outro === true; } catch { return false; }
  }
  return false;
}

'''
compose = replace_once(compose, main_marker, outro_helper + main_marker, "outro helper")
compose = replace_count(compose, 'scene?.template_data?.is_outro', 'isOutroScene(scene)', 2, "outro checks")

old_outro = '''    const hasScriptOutro = scenes.some((s) => isOutroScene(s));\n    if (!hasScriptOutro) {\n      const outroAudioBase64 = await generateSilentAudioBase64(OUTRO_DURATION_SEC);\n      scenes.push({\n        scene_index: scenes.length,\n        visual_source: "template",\n        template_name: "kinetic_text",\n        template_data: { line: reqBody.outro_line || DEFAULT_OUTRO_LINE, is_outro: true },\n        audio: { audio_base64: outroAudioBase64 },\n      });\n    }\n'''
new_outro = '''    const outroIndexes = scenes\n      .map((scene, index) => (isOutroScene(scene) ? index : -1))\n      .filter((index) => index >= 0);\n    if (outroIndexes.length > 1) {\n      throw new Error(`Expected at most one outro scene, found ${outroIndexes.length}`);\n    }\n    if (outroIndexes.length === 1) {\n      const outroIndex = outroIndexes[0];\n      if (outroIndex !== scenes.length - 1) {\n        const [outro] = scenes.splice(outroIndex, 1);\n        scenes.push(outro);\n        console.warn(`[job ${jobId}] moved script outro from index ${outroIndex} to final position`);\n      }\n    } else {\n      const outroAudioBase64 = await generateSilentAudioBase64(OUTRO_DURATION_SEC);\n      scenes.push({\n        scene_index: scenes.length,\n        visual_source: "template",\n        template_name: "kinetic_text",\n        template_data: { line: reqBody.outro_line || DEFAULT_OUTRO_LINE, is_outro: true },\n        audio: { audio_base64: outroAudioBase64 },\n      });\n    }\n'''
compose = replace_once(compose, old_outro, new_outro, "outro normalization")

old_animate = '''        const animate = !degraded && FAL_VIDEO_ENABLED && FAL_KEY && (i === 0 || i === emphasisIdx);\n        let animated = false;\n        if (animate) {\n          try {\n            const clipPath = path.join(tmpDir, `clip_${i}.mp4`);\n            await generateVideoFromImage(imageUrls[0], clipPath);\n            await buildStockVideoScene(clipPath, audioPath, duration, outPath, i, mood);\n            animated = true;\n            console.log(`[ltx] animated scene ${i} (${i === 0 ? "hook" : "payoff"})`);\n          } catch (e) {\n            console.warn(`[ltx] animation failed for scene ${i} (${e.message}) - using still`);\n          }\n        }\n'''
new_animate = '''        const animationSourceUrl = Array.isArray(imageUrls) && imageUrls.length ? imageUrls[0] : null;\n        const animate = !degraded && FAL_VIDEO_ENABLED && FAL_KEY && Boolean(animationSourceUrl) && (i === 0 || i === emphasisIdx);\n        if (!degraded && FAL_VIDEO_ENABLED && FAL_KEY && !animationSourceUrl && Array.isArray(imageBase64s) && imageBase64s.length && (i === 0 || i === emphasisIdx)) {\n          console.log(`[ltx] scene ${i} uses inline image bytes; skipping URL-only image-to-video and keeping deterministic Ken Burns motion`);\n        }\n        let animated = false;\n        if (animate) {\n          try {\n            const clipPath = path.join(tmpDir, `clip_${i}.mp4`);\n            await generateVideoFromImage(animationSourceUrl, clipPath);\n            await buildStockVideoScene(clipPath, audioPath, duration, outPath, i, mood);\n            animated = true;\n            console.log(`[ltx] animated scene ${i} (${i === 0 ? "hook" : "payoff"})`);\n          } catch (e) {\n            console.warn(`[ltx] animation failed for scene ${i} (${e.message}) - using still`);\n          }\n        }\n'''
compose = replace_once(compose, old_animate, new_animate, "inline image animation guard")

# ---------------------------------------------------------------------------
# Request-local thumbnail metadata in both /compose and /thumbnail paths.
# ---------------------------------------------------------------------------
compose = replace_once(
    compose,
    '        await buildThumbnail(reqBody.thumbnail.image_url, reqBody.thumbnail.text, reqBody.thumbnail.accent, tmpDir, thumbFull, reqBody.thumbnail.image_base64, reqBody.thumbnail.emphasis);\n        thumbnailPath = thumbFull;\n',
    '        const thumbnailResult = await buildThumbnail(reqBody.thumbnail.image_url, reqBody.thumbnail.text, reqBody.thumbnail.accent, tmpDir, thumbFull, reqBody.thumbnail.image_base64, reqBody.thumbnail.emphasis);\n        thumbnailPath = thumbnailResult.path;\n',
    "compose thumbnail result",
)
compose = replace_once(
    compose,
    '    await buildThumbnail(image_url, text, accent, tmpDir, outPath, image_base64, emphasis);\n',
    '    const thumbnailResult = await buildThumbnail(image_url, text, accent, tmpDir, outPath, image_base64, emphasis);\n',
    "thumbnail endpoint result",
)
compose = replace_once(compose, '      background: lastThumbnailBackground(),\n      layout: lastThumbnailLayout(),\n', '      background: thumbnailResult.background,\n      layout: thumbnailResult.layout,\n', "thumbnail endpoint metadata")

COMPOSE.write_text(compose, encoding="utf-8")

# ---------------------------------------------------------------------------
# Correct stale portrait expectations in the long-form output suite.
# ---------------------------------------------------------------------------
test = QUALITY_TEST.read_text(encoding="utf-8")
test = test.replace('video resolution is 1080x1920 (9:16 vertical)', 'video resolution is 1920x1080 (16:9 landscape)')
test = test.replace('1080x1920@30fps', '1920x1080@30fps')
for lhs, old, new in [
    ('videoStream.width', '1080', '1920'),
    ('videoStream.height', '1920', '1080'),
    ('video.width', '1080', '1920'),
    ('video.height', '1920', '1080'),
]:
    pattern = f'assert.strictEqual({lhs}, {old});'
    if pattern not in test:
        raise RuntimeError(f'landscape tests: expected at least one {pattern!r}')
    test = test.replace(pattern, f'assert.strictEqual({lhs}, {new});')
QUALITY_TEST.write_text(test, encoding="utf-8")

print("Applied compose hardening and landscape test corrections")
