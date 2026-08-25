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

from render_exact_benchmark import ENGINE_API, RUN_PREFIX, artifact, find_run_id, http_json

OUT = Path(os.environ.get("VISUAL_PREVIEW_MANIFEST", "visual-preview-manifest.json"))
RAW_SCENES = os.environ.get("VISUAL_PREVIEW_SCENE_INDICES", "5,17,25")
SCENE_INDICES = [int(part.strip()) for part in RAW_SCENES.split(",") if part.strip()]
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

    rows: list[dict[str, Any]] = []
    for idx in SCENE_INDICES:
        scene = asset_scenes.get(idx)
        if not scene:
            raise RuntimeError(f"asset artifact has no scene {idx}")
        category = str(scene.get("template_category") or "")
        if category != "cartoon":
            raise RuntimeError(f"scene {idx} is {category!r}, not 'cartoon'; choose representative cartoon scenes")
        raw = scene.get("template_data")
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
        rows.append({
            "scene_index": idx,
            "props": cartoon_props(data),
            # Beginning, middle and late-frame samples expose transition/acting
            # state without paying to encode all 120 frames.
            "frames": [8, 58, 108],
        })

    OUT.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    print(f"visual preview manifest: {OUT}, run={run_id}, scenes={SCENE_INDICES}")


if __name__ == "__main__":
    main()
