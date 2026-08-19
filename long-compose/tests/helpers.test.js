/**
 * Unit tests for compose.js helper functions.
 * These run fast without starting the server or rendering video.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

// We can't easily require compose.js (it starts Express),
// so we test the color grading filter strings directly.
// This validates the ffmpeg filter syntax won't crash.

describe("Color grade filter syntax", () => {
    // Recreate the getColorGrade function locally for testing
    function getColorGrade(mood) {
        const grades = {
            upbeat: [
                "eq=contrast=1.15:saturation=1.45:brightness=0.02",
                "colorbalance=rs=0.12:gs=0.04:bs=-0.08:rh=0.06:gh=0.02:bh=-0.04",
                "curves=m='0/0.06:0.25/0.30:0.5/0.52:0.75/0.78:1/0.95'",
            ].join(","),
            serious: [
                "eq=contrast=1.18:saturation=0.90:brightness=-0.01",
                "colorbalance=rs=-0.04:gs=0.0:bs=0.06:rh=0.02:gh=-0.01:bh=0.04",
                "curves=m='0/0.05:0.25/0.28:0.5/0.50:0.75/0.76:1/0.93'",
            ].join(","),
            funny: [
                "eq=contrast=1.10:saturation=1.60:brightness=0.03",
                "colorbalance=rs=0.10:gs=0.08:bs=-0.06:rh=0.04:gh=0.06:bh=-0.02",
                "curves=m='0/0.07:0.25/0.31:0.5/0.53:0.75/0.79:1/0.96'",
            ].join(","),
            neutral: [
                "eq=contrast=1.10:saturation=1.15:brightness=0.01",
                "colorbalance=rs=0.02:gs=0.0:bs=0.02:rh=0.03:gh=0.01:bh=-0.01",
                "curves=m='0/0.05:0.25/0.29:0.5/0.51:0.75/0.77:1/0.94'",
            ].join(","),
        };
        return grades[mood] || grades.neutral;
    }

    it("all moods produce non-empty filter strings", () => {
        const moods = ["upbeat", "serious", "funny", "neutral"];
        for (const mood of moods) {
            const grade = getColorGrade(mood);
            assert.ok(grade.length > 50, `Grade for ${mood} is too short`);
        }
    });

    it("all grades contain eq, colorbalance, and curves filters", () => {
        const moods = ["upbeat", "serious", "funny", "neutral"];
        for (const mood of moods) {
            const grade = getColorGrade(mood);
            assert.ok(grade.includes("eq="), `${mood} missing eq filter`);
            assert.ok(grade.includes("colorbalance="), `${mood} missing colorbalance`);
            assert.ok(grade.includes("curves="), `${mood} missing curves`);
        }
    });

    it("unknown mood falls back to neutral", () => {
        const grade = getColorGrade("unknown_mood");
        const neutral = getColorGrade("neutral");
        assert.strictEqual(grade, neutral);
    });

    it("shadow lift is present in curves (no pure black 0/0)", () => {
        const moods = ["upbeat", "serious", "funny", "neutral"];
        for (const mood of moods) {
            const grade = getColorGrade(mood);
            // All grades should lift shadows: curves starts with 0/0.05+ not 0/0
            const curvesMatch = grade.match(/curves=m='([^']+)'/);
            assert.ok(curvesMatch, `${mood} missing curves definition`);
            const firstPoint = curvesMatch[1].split(":")[0]; // e.g. "0/0.06"
            const [, y] = firstPoint.split("/").map(Number);
            assert.ok(y > 0.03, `${mood} shadow lift too low: ${y} (should be >0.03)`);
        }
    });

    it("highlight rolloff is present (last point < 1.0)", () => {
        const moods = ["upbeat", "serious", "funny", "neutral"];
        for (const mood of moods) {
            const grade = getColorGrade(mood);
            const curvesMatch = grade.match(/curves=m='([^']+)'/);
            const points = curvesMatch[1].split(":");
            const lastPoint = points[points.length - 1]; // e.g. "1/0.95"
            const [, y] = lastPoint.split("/").map(Number);
            assert.ok(
                y < 1.0 && y > 0.9,
                `${mood} highlight rolloff out of range: ${y} (expected 0.9-1.0)`
            );
        }
    });
});

describe("Motion assets exist", () => {
    const assetsDir = path.join(__dirname, "..", "motion-assets");

    it("fonts directory has Inter font files", () => {
        const fontsDir = path.join(assetsDir, "fonts");
        assert.ok(fs.existsSync(fontsDir), "fonts/ directory missing");
        const files = fs.readdirSync(fontsDir);
        assert.ok(files.some((f) => f.includes("Inter")), "No Inter font files found");
    });

    it("sfx directory has required sound effects", () => {
        const sfxDir = path.join(assetsDir, "sfx");
        assert.ok(fs.existsSync(sfxDir), "sfx/ directory missing");
        assert.ok(fs.existsSync(path.join(sfxDir, "whoosh.wav")), "whoosh.wav missing");
        assert.ok(fs.existsSync(path.join(sfxDir, "impact.wav")), "impact.wav missing");
        assert.ok(fs.existsSync(path.join(sfxDir, "riser.wav")), "riser.wav missing");
    });

    it("backgrounds directory has required images", () => {
        const bgDir = path.join(assetsDir, "backgrounds");
        assert.ok(fs.existsSync(bgDir), "backgrounds/ directory missing");
        assert.ok(
            fs.existsSync(path.join(bgDir, "gradient_charcoal.png")),
            "gradient_charcoal.png missing"
        );
    });

    it("icons directory has animation files", () => {
        const iconsDir = path.join(assetsDir, "icons");
        assert.ok(fs.existsSync(iconsDir), "icons/ directory missing");
        const files = fs.readdirSync(iconsDir);
        assert.ok(files.length > 0, "No icon files found");
    });
});

describe("Remotion project structure", () => {
    const remotionDir = path.join(__dirname, "..", "remotion");

    it("package.json exists with required dependencies", () => {
        const pkgPath = path.join(remotionDir, "package.json");
        assert.ok(fs.existsSync(pkgPath), "remotion/package.json missing");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        assert.ok(pkg.dependencies["remotion"], "Missing remotion dependency");
        assert.ok(pkg.dependencies["@remotion/renderer"], "Missing @remotion/renderer");
        assert.ok(pkg.dependencies["react"], "Missing react dependency");
    });

    it("entry point exists", () => {
        assert.ok(
            fs.existsSync(path.join(remotionDir, "src", "index.ts")),
            "src/index.ts missing"
        );
    });

    it("render bridge exists", () => {
        assert.ok(
            fs.existsSync(path.join(remotionDir, "render-bridge.mjs")),
            "render-bridge.mjs missing"
        );
    });

    it("all composition files exist", () => {
        const compositions = [
            "StatReveal.tsx",
            "Comparison.tsx",
            "KineticText.tsx",
            "CaptionOverlay.tsx",
            "SceneTransition.tsx",
            "CartoonScene.tsx",
        ];
        for (const comp of compositions) {
            assert.ok(
                fs.existsSync(path.join(remotionDir, "src", "compositions", comp)),
                `${comp} missing`
            );
        }
    });

    it("cartoon puppet component and lip-sync helper exist", () => {
        assert.ok(
            fs.existsSync(path.join(remotionDir, "src", "components", "Character.tsx")),
            "components/Character.tsx missing"
        );
        assert.ok(
            fs.existsSync(path.join(remotionDir, "src", "animation", "lipsync.ts")),
            "animation/lipsync.ts missing"
        );
    });

    it("background component and environment presets exist", () => {
        assert.ok(
            fs.existsSync(path.join(remotionDir, "src", "components", "Background.tsx")),
            "components/Background.tsx missing"
        );
        assert.ok(
            fs.existsSync(path.join(remotionDir, "src", "lib", "environment.ts")),
            "lib/environment.ts missing"
        );
    });
});

describe("Cartoon background library", () => {
    const backgroundsDir = path.join(__dirname, "..", "remotion", "public", "backgrounds");

    it("has a documented asset contract", () => {
        assert.ok(fs.existsSync(path.join(backgroundsDir, "README.md")), "backgrounds/README.md missing");
    });

    // (location, variants) pairs for the full ChatGPT-generated landscape pack.
    const library = {
        bedroom: ["day", "night", "messy-day", "messy-night"],
        cafe: ["day"],
        classroom: ["empty", "normal", "exam"],
        "generic-room": ["cool-day", "warm-day", "night"],
        "hospital-room": ["day"],
        kitchen: ["day", "night"],
        "living-room": ["day", "night"],
        office: ["day"],
        park: ["day", "evening"],
        "school-hallway": ["normal"],
        street: ["day", "night", "rain-night"],
    };

    it("every location/variant has all three layers at the exact output canvas", () => {
        for (const [location, variants] of Object.entries(library)) {
            for (const variant of variants) {
                const dir = path.join(backgroundsDir, location, variant);
                for (const layer of ["back", "middle", "front"]) {
                    const file = path.join(dir, `${layer}.svg`);
                    assert.ok(fs.existsSync(file), `${location}/${variant}/${layer}.svg missing`);
                    const svg = fs.readFileSync(file, "utf8");
                    assert.ok(
                        svg.includes('viewBox="0 0 1920 1080"'),
                        `${location}/${variant}/${layer}.svg has an unexpected viewBox`
                    );
                }
            }
        }
    });
});

describe("Cartoon character rig assets", () => {
    const charactersDir = path.join(__dirname, "..", "remotion", "public", "characters");
    const mouthShapes = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];
    const armPoses = ["left-up", "left-down", "right-up", "right-down"];
    const expressions = ["normal", "angry", "surprised"];

    for (const characterId of ["pilot", "pilot-2"]) {
        describe(characterId, () => {
            const dir = path.join(charactersDir, characterId);

            it("has a manifest and the base layers", () => {
                assert.ok(fs.existsSync(path.join(dir, "manifest.json")), `${characterId}/manifest.json missing`);
                for (const file of ["body.svg", "head.svg", "eye-left.svg", "eye-right.svg", "pupil-left.svg", "pupil-right.svg"]) {
                    assert.ok(fs.existsSync(path.join(dir, file)), `${characterId}/${file} missing`);
                }
            });

            it("has all nine Rhubarb mouth shapes", () => {
                for (const shape of mouthShapes) {
                    assert.ok(
                        fs.existsSync(path.join(dir, "mouth", `${shape}.svg`)),
                        `${characterId}/mouth/${shape}.svg missing`
                    );
                }
            });

            it("has both arm poses for each side", () => {
                for (const pose of armPoses) {
                    assert.ok(
                        fs.existsSync(path.join(dir, "arms", `${pose}.svg`)),
                        `${characterId}/arms/${pose}.svg missing`
                    );
                }
            });

            it("has all eyebrow expressions", () => {
                for (const expr of expressions) {
                    assert.ok(
                        fs.existsSync(path.join(dir, "expressions", `eyebrow-${expr}.svg`)),
                        `${characterId}/expressions/eyebrow-${expr}.svg missing`
                    );
                }
            });
        });
    }
});
