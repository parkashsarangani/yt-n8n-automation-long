#!/usr/bin/env python3
"""Render the exact persisted cartoon episode through an isolated long-compose.

This script deliberately does not call any LLM/TTS/image provider. It finds the
existing successful render record by run-id prefix, reloads the exact script,
voice, asset-manifest and cast artifacts that fed that render, reads their
content-addressed blobs from the running production engine container, and posts
the same scene payload to a compositor URL supplied by BENCHMARK_COMPOSE_URL.

It is intended for the self-hosted visual-quality benchmark workflow only.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ENGINE_API = os.environ.get("BENCHMARK_ENGINE_API", "http://127.0.0.1:4321/api")
COMPOSE = os.environ.get("BENCHMARK_COMPOSE_URL", "http://127.0.0.1:4011").rstrip("/")
RUN_PREFIX = os.environ.get("BENCHMARK_RUN_PREFIX", "run_385203f1")
OUT = Path(os.environ.get("BENCHMARK_OUTPUT", "benchmark-output.mp4"))
META = Path(os.environ.get("BENCHMARK_METADATA", "benchmark-metadata.json"))


def http_json(url: str, method: str = "GET", body: Any | None = None, host_local: bool = False) -> Any:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if host_local:
        headers["Host"] = "localhost"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {exc.code} {url}: {detail[:1200]}") from exc


def http_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=180) as response:
        return response.read()


def find_run_id() -> str:
    payload = http_json(f"{ENGINE_API}/runs", host_local=True)
    candidates = [str(run.get("run_id", "")) for run in payload.get("runs", [])]
    exact = [run_id for run_id in candidates if run_id.startswith(RUN_PREFIX)]
    if len(exact) != 1:
        raise RuntimeError(f"expected one persisted run starting {RUN_PREFIX!r}, found {exact}")
    return exact[0]


def artifact(artifact_id: str) -> dict[str, Any]:
    payload = http_json(f"{ENGINE_API}/artifacts/{artifact_id}", host_local=True)
    value = payload.get("artifact")
    if not isinstance(value, dict):
        raise RuntimeError(f"artifact {artifact_id} unavailable")
    return value


def production_engine_container() -> str:
    cmd = ["docker", "ps", "--filter", "publish=4321", "--format", "{{.ID}}"]
    ids = subprocess.check_output(cmd, text=True).strip().splitlines()
    if len(ids) != 1:
        raise RuntimeError(f"expected one production engine container publishing 4321, found {ids}")
    return ids[0]


def blob_bytes(container: str, uri: str) -> bytes:
    prefix = "blob://sha256:"
    if not uri.startswith(prefix):
        raise RuntimeError(f"not a content-addressed blob URI: {uri}")
    digest = uri[len(prefix):]
    if len(digest) != 64:
        raise RuntimeError(f"malformed blob digest: {uri}")
    path = f"/data/blobs/{digest[:2]}/{digest}"
    proc = subprocess.run(["docker", "exec", container, "cat", path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(f"persisted blob is unavailable/pruned: {uri}: {proc.stderr.decode('utf-8', 'replace')[:400]}")
    return proc.stdout


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def stable_hash(value: str) -> int:
    h = 2166136261
    for ch in value:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


FALLBACK_COLORS = ["#7EC8E3", "#FFB86B", "#B8E986", "#FF8FA3", "#C9A6F5", "#FFE066"]


def speaker_for(template_data: dict[str, Any], cast: dict[str, dict[str, Any]]) -> tuple[str, str] | None:
    speaking = next((c for c in template_data.get("characters", []) if isinstance(c, dict) and c.get("isSpeaking") is True), None)
    if not speaking:
        return None
    actor_id = speaking.get("actorId")
    character = cast.get(str(actor_id))
    if not character:
        return None
    palette = character.get("color_palette") or []
    color = next((c for c in palette if isinstance(c, str) and len(c) == 7 and c.startswith("#")), None)
    if not color:
        color = FALLBACK_COLORS[stable_hash(str(actor_id)) % len(FALLBACK_COLORS)]
    return str(character.get("name") or actor_id), color


def main() -> None:
    run_id = find_run_id()
    detail = http_json(f"{ENGINE_API}/runs/{run_id}", host_local=True)
    records = detail.get("records", [])
    render_records = [r for r in records if r.get("node_id") == "render" and isinstance(r.get("inputs"), list) and len(r["inputs"]) >= 4]
    if not render_records:
        raise RuntimeError(f"run {run_id} has no persisted render record with four inputs")
    render_record = render_records[-1]
    script_id, voice_id, assets_id, cast_id = render_record["inputs"][:4]
    script = artifact(script_id)
    voice = artifact(voice_id)
    assets = artifact(assets_id)
    cast_art = artifact(cast_id)

    script_scenes = sorted(script["payload"]["scenes"], key=lambda s: int(s["scene_index"]))
    clips = {int(c["scene_index"]): c for c in voice["payload"]["clips"]}
    asset_scenes = {int(a["scene_index"]): a for a in assets["payload"]["scenes"]}
    cast = {str(c["character_id"]): c for c in cast_art["payload"]["characters"]}
    engine_container = production_engine_container()

    data: list[dict[str, Any]] = []
    degraded = 0
    for scene in script_scenes:
        idx = int(scene["scene_index"])
        clip = clips.get(idx)
        if clip is None:
            raise RuntimeError(f"voice artifact has no clip for scene {idx}")
        asset_scene = asset_scenes.get(idx, {})
        audio_obj: dict[str, Any] = {"audio_base64": b64(blob_bytes(engine_container, clip["audio_uri"]))}
        if clip.get("alignment_uri"):
            audio_obj["alignment"] = json.loads(blob_bytes(engine_container, clip["alignment_uri"]).decode("utf-8"))

        row: dict[str, Any] = {"scene_index": idx, "audio": audio_obj}
        if asset_scene.get("video_uri"):
            row["video_base64"] = b64(blob_bytes(engine_container, asset_scene["video_uri"]))
        elif asset_scene.get("image_uri"):
            row["images_base64"] = [b64(blob_bytes(engine_container, asset_scene["image_uri"]))]
        elif not asset_scene.get("template_category"):
            row["_degraded"] = True
            degraded += 1

        if scene.get("is_outro"):
            row.update({"visual_source": "template", "template_name": "kinetic_text"})
        elif asset_scene.get("template_category"):
            raw_template = asset_scene.get("template_data")
            template_data = json.loads(raw_template) if isinstance(raw_template, str) else (raw_template or {})
            row.update({
                "visual_source": "template",
                "template_name": asset_scene["template_category"],
                "template_data": template_data,
            })
            speaker = speaker_for(template_data, cast)
            if speaker:
                row["speaker_name"], row["speaker_color"] = speaker
        data.append(row)

    request_body = {
        "caption_style": "neutral",
        "comment_hook": None,
        "outro_line": "What should we explain next? Subscribe.",
        "data": data,
    }
    submitted = http_json(f"{COMPOSE}/compose", method="POST", body=request_body)
    job_id = submitted.get("job_id")
    if not job_id:
        raise RuntimeError(f"isolated compositor returned no job id: {submitted}")

    deadline = time.time() + 3600
    status: dict[str, Any] = {}
    while time.time() < deadline:
        time.sleep(8)
        status = http_json(f"{COMPOSE}/compose-status/{job_id}")
        if status.get("status") == "processing":
            print(f"benchmark render {job_id}: processing", flush=True)
            continue
        break
    if status.get("status") != "done" or status.get("success") is False or not status.get("output_path"):
        raise RuntimeError(f"benchmark render failed: {status}")

    output_name = str(status["output_path"]).rsplit("/", 1)[-1]
    video = http_bytes(f"{COMPOSE}/outputs/{output_name}")
    OUT.write_bytes(video)
    META.write_text(json.dumps({
        "run_id": run_id,
        "source_render_artifact": render_record.get("output"),
        "input_artifacts": {"script": script_id, "voice": voice_id, "assets": assets_id, "cast": cast_id},
        "scene_count": len(data),
        "degraded_source_scenes": degraded,
        "benchmark_job_id": job_id,
        "benchmark_status": status,
        "bytes": len(video),
    }, indent=2) + "\n", encoding="utf-8")
    print(f"exact benchmark rendered: {OUT} ({len(video)} bytes), run={run_id}, scenes={len(data)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"BENCHMARK ERROR: {exc}", file=sys.stderr)
        raise
