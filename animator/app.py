"""Animator service: the engine's auto-edit asks it for an animated clip of
one beat image (blinks; mouth and hand motion for speaking characters).

POST /animate  JSON {"image": <base64 PNG, the 1080x1080 scene>, "frames": int,
                     "start_frame": int, "envelope": [0..1 per frame], "seed": int}
            -> 200 video/mp4 (header X-Animate-Summary: what was found)
GET  /health   -> 200 once the service is up (models load on first use)

One request is rendered at a time: it is CPU-bound, and the engine renders a
Short's shots one after another anyway.
"""
import base64
import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import animate

_render_lock = threading.Lock()
MAX_BODY = 64 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"ok":true}')
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path != "/animate":
            self._send(404, b'{"error":"not found"}')
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= MAX_BODY:
                raise ValueError("bad request size")
            req = json.loads(self.rfile.read(n))
            png = base64.b64decode(req["image"])
            with _render_lock:
                video, found = animate.render_clip(png, int(req["frames"]), int(req.get("start_frame", 0)),
                                                   [float(v) for v in req.get("envelope", [])], int(req.get("seed", 0)))
            self._send(200, video, "video/mp4", {"X-Animate-Summary": json.dumps(found)})
        except (KeyError, ValueError) as err:
            self._send(400, json.dumps({"error": str(err)}).encode())
        except Exception as err:  # noqa: BLE001 -- reported to the engine, which falls back to a still shot
            traceback.print_exc()
            self._send(500, json.dumps({"error": f"{type(err).__name__}: {err}"}).encode())

    def log_message(self, fmt, *args):
        if "/health" not in (args[0] if args else ""):
            print(f"[animator] {fmt % args}", flush=True)


def warm():
    try:
        animate.models()
        print("[animator] models loaded", flush=True)
    except Exception:  # noqa: BLE001 -- first request retries
        traceback.print_exc()


if __name__ == "__main__":
    threading.Thread(target=warm, daemon=True).start()
    port = int(os.environ.get("PORT", "4100"))
    print(f"[animator] listening on {port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
