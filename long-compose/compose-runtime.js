const fs = require("fs");
const path = require("path");
const Module = require("module");

const composePath = path.join(__dirname, "compose.js");
let source = fs.readFileSync(composePath, "utf8");

function replaceOnce(haystack, needle, replacement, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`[compose-runtime] unable to apply ${label}; compose.js source shape changed`);
  }
  const updated = haystack.replace(needle, replacement);
  if (updated === haystack) {
    throw new Error(`[compose-runtime] ${label} did not change compose.js source`);
  }
  return updated;
}

source = replaceOnce(
  source,
  `    cartoon: {\n      compositionId: "CartoonScene",\n      buildProps: (d) => ({\n        background: resolveBackgroundLayers(d.background),\n        camera: d.camera,\n        characters: d.characters || [],\n      }),\n    },`,
  `    cartoon: {\n      compositionId: "CartoonScene",\n      buildProps: (d) => ({\n        background: resolveBackgroundLayers(d.background),\n        camera: d.camera,\n        characters: d.characters || [],\n        visualEvent: d.visualEvent,\n        speakerEmphasis: d.speakerEmphasis,\n      }),\n    },`,
  "cartoon direction prop forwarding",
);

source = replaceOnce(
  source,
  `    // Gapless voiceover: rejoin the per-scene voice cleanly (no boundary\n    // clicks) with a single loudnorm (consistent levels), used as the voice\n    // track below instead of the concatenated video's gappy audio.\n    const voicePath = path.join(tmpDir, "voice_full.m4a");\n    await buildGaplessVoice(\n      scenes.map((_, i) => path.join(tmpDir, \`voice_\${i}.mp3\`)),\n      voicePath\n    );\n\n    // ===== PHASE 5: Final composite — video + captions + music + SFX =====`,
  `    // Cartoon mouth cues are rendered into each per-scene Remotion clip from\n    // that scene's own narration audio. Rebuilding a separate gapless voice\n    // track for the final mux changes scene-boundary timing and creates\n    // cumulative lip-sync drift in the back half. For cartoon template renders,\n    // preserve the concatenated scene audio as the final voice source.\n    const preserveSceneAudioForLipSync = scenes.some(\n      (scene) => scene?.visual_source === "template" && scene?.template_name === "cartoon",\n    );\n    let voicePath = null;\n    if (!preserveSceneAudioForLipSync) {\n      // Gapless voiceover: rejoin the per-scene voice cleanly for non-lip-sync\n      // paths, where the video has no mouth animation tied to per-scene audio.\n      voicePath = path.join(tmpDir, "voice_full.m4a");\n      await buildGaplessVoice(\n        scenes.map((_, i) => path.join(tmpDir, \`voice_\${i}.mp3\`)),\n        voicePath\n      );\n    }\n\n    // ===== PHASE 5: Final composite — video + captions + music + SFX =====`,
  "cartoon lip-sync audio preservation setup",
);

source = replaceOnce(
  source,
  `    const finalCmd = ffmpeg().input(concatPath);   // [0] = video (+ ignored audio)\n    finalCmd.input(voicePath);                     // [1] = gapless voiceover\n    if (hasMusic) finalCmd.input(musicPath);\n    sfxEvents.forEach((ev) => finalCmd.input(sfxFiles[ev.type]));\n\n    // Track input indices ([0]=video, [1]=voice already taken)\n    let nextIdx = 2;\n    const musicIdx = hasMusic ? nextIdx++ : null;\n    const sfxIndices = sfxEvents.map(() => nextIdx++);`,
  `    const finalCmd = ffmpeg().input(concatPath);   // [0] = concatenated video with scene-timed audio\n    if (!preserveSceneAudioForLipSync) {\n      finalCmd.input(voicePath);                   // [1] = rebuilt voiceover for non-cartoon paths\n    }\n    if (hasMusic) finalCmd.input(musicPath);\n    sfxEvents.forEach((ev) => finalCmd.input(sfxFiles[ev.type]));\n\n    // Track input indices. For cartoon lip-sync we intentionally keep [0:a]\n    // as the voice source so mouth cues and audible speech share boundaries.\n    const voiceLabel = preserveSceneAudioForLipSync ? "0:a" : "1:a";\n    let nextIdx = preserveSceneAudioForLipSync ? 1 : 2;\n    const musicIdx = hasMusic ? nextIdx++ : null;\n    const sfxIndices = sfxEvents.map(() => nextIdx++);`,
  "cartoon final voice input selection",
);

source = replaceOnce(
  source,
  `    const audioFilters = [];\n    const mixLabels = ["1:a"];\n\n    if (hasMusic) {\n      // Gentler ducking: ratio 4 instead of 10, shaped attack/release\n      audioFilters.push(\`[\${musicIdx}:a]aloop=loop=-1:size=2e9,volume=0.15[music]\`);\n      audioFilters.push(\`[music][1:a]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=200[duckedmusic]\`);\n      mixLabels.push("duckedmusic");\n    }`,
  `    const audioFilters = [];\n    const mixLabels = [voiceLabel];\n\n    if (hasMusic) {\n      // Gentler ducking: ratio 4 instead of 10, shaped attack/release\n      audioFilters.push(\`[\${musicIdx}:a]aloop=loop=-1:size=2e9,volume=0.15[music]\`);\n      audioFilters.push(\`[music][\${voiceLabel}]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=200[duckedmusic]\`);\n      mixLabels.push("duckedmusic");\n    }`,
  "cartoon final audio filter voice label",
);

const patchedModule = new Module(composePath, module.parent);
patchedModule.filename = composePath;
patchedModule.paths = Module._nodeModulePaths(__dirname);
patchedModule._compile(source, composePath);
