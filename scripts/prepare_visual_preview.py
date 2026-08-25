#!/usr/bin/env python3
"""Prepare exact persisted CartoonScene props for fast visual-only QA.

This reuses the same persisted run/artifact inputs as render_exact_benchmark.py,
but deliberately stops before narration, Rhubarb and ffmpeg. The output is a
small JSON manifest consumed by remotion/preview-bridge.mjs.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from render_exact_benchmark import ENGINE_API, artifact, find_run_id, http_json

OUT = Path(os.environ.get("VISUAL_PREVIEW_MANIFEST", "visual-preview-manifest.json"))
RAW_SCENES = os.environ.get("VISUAL_PREVIEW_SCENE_INDICES", "").strip()
SCENE_INDICES = [int(part.strip()) for part in RAW_SCENES.split(",") if part.strip()] if RAW_SCENES else []
RAW_RECIPES = os.environ.get(
    "VISUAL_PREVIEW_RECIPES",
    "establishing,reaction-closeup,prop-insert,over-shoulder,crossing-transition,payoff-hold",
)
RECIPES = [part.strip().lower() for part in RAW_RECIPES.split(",") if part.strip()]
PUBLIC = Path("long-compose/remotion/public")


def resolve_background_layers(background: Any) -> Any:
    if not isinstance(background, dict):
        return background
    if background.get("flat") or not background.get("location") or not background.get("variant"):
        return background
    directory = PUBLIC / "backgrounds" / str(background["location"]) / str(background["variant"])
    resolved = dict(background)
    resolved["layers"] = {
        "back": (directory / "back.svg").exists(),
        "middle": (directory / "middle.svg").exists(),
        "front": (directory / "front.svg").exists(),
    }
    return resolved


def cartoon_props(template_data: dict[str, Any]) -> dict[str, Any]:
    # Mirrors long-compose/compose.js's cartoon buildProps contract exactly.
    return {
        "background": resolve_background_layers(template_data.get("background")),
        "camera": template_data.get("camera"),
        "characters": template_data.get("characters") or [],
        "visualEvent": template_data.get("visualEvent"),
        "speakerEmphasis": template_data.get("speakerEmphasis"),
        "shotType": template_data.get("shotType") or template_data.get("framing"),
        "visualStyle": template_data.get("visualStyle") or template_data.get("visual_style"),
        "cinematic": template_data.get("cinematic"),
    }


def parse_template(scene: dict[str, Any]) -> dict[str, Any]:
    raw = scene.get("template_data")
    return json.loads(raw) if isinstance(raw, str) else (raw or {})


def recipe_for(scene: dict[str, Any]) -> str:
    data = parse_template(scene)
    cinematic = data.get("cinematic") if isinstance(data, dict) else None
    return str((cinematic or {}).get("shotRecipe") or "two-shot").lower().strip()


def choose_scene_indices(asset_scenes: dict[int, dict[str, Any]]) -> list[int]:
    if SCENE_INDICES:
        return SCENE_INDICES

    cartoons = [
        scene for _, scene in sorted(asset_scenes.items())
        if str(scene.get("template_category") or "") == "cartoon"
    ]
    selected: list[int] = []
    used: set[int] = set()

    # Prefer one exact persisted scene for each cinematic recipe. This lets the
    # contact sheet expose whether recipe metadata actually creates distinct pixels.
    for wanted in RECIPES:
        match = next(
            (scene for scene in cartoons if int(scene["scene_index"]) not in used and recipe_for(scene) == wanted),
            None,
        )
        if match is not None:
            idx = int(match["scene_index"])
            selected.append(idx)
            used.add(idx)

    # Keep the preview shape stable even when this particular episode omits a recipe.
    # Fill from other cartoon scenes rather than failing the visual QA loop.
    for scene in cartoons:
        if len(selected) >= len(RECIPES):
            break
        idx = int(scene["scene_index"])
        if idx not in used:
            selected.append(idx)
            used.add(idx)

    if len(selected) != len(RECIPES):
        raise RuntimeError(f"needed {len(RECIPES)} representative cartoon scenes, found {selected}")
    return selected


def main() -> None:
    run_id = find_run_id()
    detail = http_json(f"{ENGINE_API}/runs/{run_id}", host_local=True)
    records = detail.get("records", [])
    render_records = [r for r in records if r.get("node_id") == "render" and isinstance(r.get("inputs"), list) and len(r["inputs"]) >= 4]
    if not render_records:
        raise RuntimeError(f"run {run_id} has no persisted render record with four inputs")
    render_record = render_records[-1]
    assets_id = render_record["inputs"][2]
    assets = artifact(assets_id)
    asset_scenes = {int(a["scene_index"]): a for a in assets["payload"]["scenes"]}
    selected = choose_scene_indices(asset_scenes)

    rows: list[dict[str, Any]] = []
    for idx in selected:
        scene = asset_scenes.get(idx)
        if not scene:
            raise RuntimeError(f"asset artifact has no scene {idx}")
        category = str(scene.get("template_category") or "")
        if category != "cartoon":
            raise RuntimeError(f"scene {idx} is {category!r}, not 'cartoon'; choose representative cartoon scenes")
        data = parse_template(scene)
        rows.append({
            "scene_index": idx,
            "recipe": recipe_for(scene),
            "props": cartoon_props(data),
            # Early and late samples reveal staging/camera/acting change while
            # keeping this loop far cheaper than encoding complete clips.
            "frames": [18, 90],
        })

    OUT.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    labels = [f"{row['scene_index']}:{row['recipe']}" for row in rows]
    print(f"visual preview manifest: {OUT}, run={run_id}, scenes={labels}")


if __name__ == "__main__":
    main()
