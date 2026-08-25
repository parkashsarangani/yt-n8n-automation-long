#!/usr/bin/env python3
"""Prepare persisted CartoonScene props for fast visual-only QA.

The preview loop reuses the same persisted benchmark episode as the exact render,
but stops before narration, Rhubarb and ffmpeg assembly. When the persisted
legacy episode does not contain one of the modern cinematic recipe families, the
preview creates a controlled synthetic variant from a real persisted scene by
overriding only renderer-facing shot/camera/acting metadata. This lets us test
whether each recipe produces materially different pixels without pretending the
old episode was planned with shot language it never had.
"""
from __future__ import annotations

from copy import deepcopy
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

RECIPE_SHOT_TYPE = {
    "establishing": "wide",
    "two-shot": "medium",
    "reaction-closeup": "close-up",
    "prop-insert": "prop-close-up",
    "over-shoulder": "medium",
    "crossing-transition": "doorway-transition",
    "callback-reveal": "close-up",
    "payoff-hold": "medium",
}
RECIPE_CAMERA = {
    "establishing": "slow-push",
    "two-shot": "static",
    "reaction-closeup": "reaction-push",
    "prop-insert": "prop-focus",
    "over-shoulder": "static",
    "crossing-transition": "doorway-track",
    "callback-reveal": "reaction-push",
    "payoff-hold": "payoff-hold",
}
RECIPE_ACTING = {
    "establishing": "neutral-hold",
    "two-shot": "neutral-hold",
    "reaction-closeup": "double-take",
    "prop-insert": "notices-prop",
    "over-shoulder": "neutral-hold",
    "crossing-transition": "walk-cross",
    "callback-reveal": "notices-prop",
    "payoff-hold": "payoff-freeze",
}


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


def cartoon_scenes(asset_scenes: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        scene for _, scene in sorted(asset_scenes.items())
        if str(scene.get("template_category") or "") == "cartoon"
    ]


def seed_scene(cartoons: list[dict[str, Any]]) -> dict[str, Any]:
    """Choose a real two-character/prop scene as the controlled matrix base."""
    prop_insert = next((scene for scene in cartoons if recipe_for(scene) == "prop-insert"), None)
    if prop_insert is not None:
        return prop_insert
    two_actor = next(
        (
            scene for scene in cartoons
            if len(parse_template(scene).get("characters") or []) >= 2
            and (parse_template(scene).get("visualEvent") or {}).get("foregroundProp")
        ),
        None,
    )
    return two_actor or cartoons[0]


def with_recipe(props: dict[str, Any], recipe: str) -> dict[str, Any]:
    """Override only renderer-facing direction for a controlled visual matrix."""
    directed = deepcopy(props)
    cinematic = dict(directed.get("cinematic") or {})
    cinematic["shotRecipe"] = recipe
    cinematic["cameraIntent"] = RECIPE_CAMERA.get(recipe, "static")
    cinematic["actingPreset"] = RECIPE_ACTING.get(recipe, "neutral-hold")
    quality_tags = [
        tag for tag in cinematic.get("qualityTags", [])
        if isinstance(tag, str) and not tag.startswith("recipe:")
    ]
    cinematic["qualityTags"] = [*quality_tags, f"recipe:{recipe}", "synthetic-recipe-qa"]
    directed["cinematic"] = cinematic
    directed["shotType"] = RECIPE_SHOT_TYPE.get(recipe, directed.get("shotType") or "medium")
    return directed


def exact_rows(asset_scenes: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for order, idx in enumerate(SCENE_INDICES, start=1):
        scene = asset_scenes.get(idx)
        if not scene:
            raise RuntimeError(f"asset artifact has no scene {idx}")
        if str(scene.get("template_category") or "") != "cartoon":
            raise RuntimeError(f"scene {idx} is not cartoon")
        data = parse_template(scene)
        rows.append({
            "preview_order": order,
            "preview_id": f"scene-{idx}",
            "scene_index": idx,
            "recipe": recipe_for(scene),
            "source_recipe": recipe_for(scene),
            "synthetic": False,
            "props": cartoon_props(data),
            "frames": [18, 90],
        })
    return rows


def recipe_matrix_rows(asset_scenes: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    cartoons = cartoon_scenes(asset_scenes)
    if not cartoons:
        raise RuntimeError("persisted benchmark has no cartoon scenes")
    seed = seed_scene(cartoons)
    rows: list[dict[str, Any]] = []

    for order, wanted in enumerate(RECIPES, start=1):
        exact = next((scene for scene in cartoons if recipe_for(scene) == wanted), None)
        source = exact or seed
        source_idx = int(source["scene_index"])
        source_recipe = recipe_for(source)
        base_props = cartoon_props(parse_template(source))
        synthetic = exact is None
        props = with_recipe(base_props, wanted) if synthetic else base_props
        rows.append({
            "preview_order": order,
            "preview_id": wanted,
            "scene_index": source_idx,
            "recipe": wanted,
            "source_recipe": source_recipe,
            "synthetic": synthetic,
            "props": props,
            "frames": [18, 90],
        })
    return rows


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

    rows = exact_rows(asset_scenes) if SCENE_INDICES else recipe_matrix_rows(asset_scenes)
    OUT.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    labels = [
        f"{row['preview_id']}<-scene{row['scene_index']}:{row['source_recipe']}"
        + ("[synthetic]" if row["synthetic"] else "[persisted]")
        for row in rows
    ]
    print(f"visual preview manifest: {OUT}, run={run_id}, matrix={labels}")


if __name__ == "__main__":
    main()
