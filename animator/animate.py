"""Face and hand animation for one beat image (operator 2026-10-11).

The body never moves. Every character with a visible face blinks; a
character drawn as speaking -- an open (red) mouth in the series style, or a
phone at the ear -- also moves its mouth with the narration's loudness and,
when a free hand is visible, gestures a little with it. Everything else in
the picture stays exactly as drawn.

Finding things: OWLv2 (open-vocabulary detection) proposes people, phones
and hands; Segment Anything cuts each one out precisely. Both are open
source (Apache 2.0) and run on CPU. Eyes and mouths are found in the cut-out
face by simple shape and colour rules that suit the flat series style.
"""
from __future__ import annotations

import hashlib
import math
import subprocess
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np

S = 1080
FPS = 30
OWL_ID = "google/owlv2-base-patch16-ensemble"
SAM_ID = "facebook/sam-vit-base"

_models: dict = {}
_models_lock = threading.Lock()


def models() -> dict:
    with _models_lock:
        if not _models:
            from transformers import Owlv2ForObjectDetection, Owlv2Processor, SamModel, SamProcessor
            _models["op"] = Owlv2Processor.from_pretrained(OWL_ID)
            _models["om"] = Owlv2ForObjectDetection.from_pretrained(OWL_ID).eval()
            _models["sp"] = SamProcessor.from_pretrained(SAM_ID)
            _models["sm"] = SamModel.from_pretrained(SAM_ID).eval()
        return _models


# ------------------------------------------------------------------ detection

def owl_boxes(pil, queries, threshold):
    import torch
    m = models()
    with torch.no_grad():
        inp = m["op"](text=[queries], images=pil, return_tensors="pt")
        out = m["om"](**inp)
        res = m["op"].post_process_grounded_object_detection(
            out, threshold=threshold, target_sizes=torch.tensor([[pil.size[1], pil.size[0]]]))[0]
    return [(b.numpy(), float(s)) for b, s in zip(res["boxes"], res["scores"])]


def sam_mask(pil, box, point):
    """The largest SAM proposal that contains `point` and stays inside `box`."""
    import torch
    m = models()
    W, H = pil.size
    with torch.no_grad():
        sin = m["sp"](pil, input_boxes=[[[float(v) for v in box]]], input_points=[[[[float(point[0]), float(point[1])]]]],
                      input_labels=[[[1]]], return_tensors="pt")
        sout = m["sm"](**sin, multimask_output=True)
        props = m["sp"].image_processor.post_process_masks(sout.pred_masks, sin["original_sizes"], sin["reshaped_input_sizes"])[0][0].numpy()
    x0, y0, x1, y1 = [int(v) for v in box]
    boxm = np.zeros((H, W), bool)
    boxm[max(0, y0 - 4):y1 + 4, max(0, x0 - 4):x1 + 4] = True
    px, py = int(min(W - 1, max(0, point[0]))), int(min(H - 1, max(0, point[1])))
    barea = max(1, (x1 - x0) * (y1 - y0))
    valid = [k for k in props if k.sum() and k[py, px] and (k & boxm).sum() / k.sum() > 0.9 and k.sum() / barea < 0.85]
    best = max(valid, key=lambda k: k.sum()) if valid else props[int(np.argmax(sout.iou_scores[0, 0].numpy()))]
    return (best & boxm).astype(np.uint8)


def character_masks(pil):
    """One mask per person in the picture (holes filled, largest piece kept)."""
    W, H = pil.size
    found = owl_boxes(pil, ["a cartoon person", "a stick figure character"], 0.15)
    if not found:
        return []
    boxes = [b for b, _ in found]
    keep = cv2.dnn.NMSBoxes([[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes],
                            [s for _, s in found], 0.15, 0.4)
    out = []
    for i in np.array(keep).flatten():
        b = boxes[int(i)]
        if (b[2] - b[0]) * (b[3] - b[1]) < 0.02 * W * H:
            continue
        # Detector boxes often stop at the shoulders: stretch up for the head.
        w, h = b[2] - b[0], b[3] - b[1]
        b = np.array([max(0, b[0] - 0.08 * w), max(0, b[1] - 0.35 * h), min(W, b[2] + 0.08 * w), min(H, b[3] + 0.02 * h)])
        cx, cy = float((b[0] + b[2]) / 2), float(b[1] + 0.55 * (b[3] - b[1]))
        mk = sam_mask(pil, b, (cx, cy))
        mk = cv2.morphologyEx(mk, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        n, lab, st, _ = cv2.connectedComponentsWithStats(mk, 8)
        if n > 1:
            mk = (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
        cnts, _ = cv2.findContours(mk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        mk = cv2.drawContours(np.zeros_like(mk), cnts, -1, 1, thickness=cv2.FILLED)
        out.append(mk.astype(np.uint8))
    return out


def find_eyes(img, mask, box):
    """Two dark dots of similar size side by side in the upper head: the eyes."""
    x0, y0, x1, y1 = box
    h = y1 - y0
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    region = np.zeros_like(mask)
    region[y0:y0 + int(0.36 * h), x0:x1] = mask[y0:y0 + int(0.36 * h), x0:x1]
    dark = ((gray < 80) & (region > 0)).astype(np.uint8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(dark, 8)
    cand = []
    for i in range(1, n):
        x, y, w, hh, a = st[i]
        if 25 <= a <= 2500 and 0.45 <= w / max(1, hh) <= 1.9 and a / max(1, w * hh) > 0.45:
            cand.append((i, x, y, w, hh, a, cen[i]))
    best, best_score = None, 1e9
    for i in range(len(cand)):
        for j in range(i + 1, len(cand)):
            a, b = cand[i], cand[j]
            dy, dx = abs(a[6][1] - b[6][1]), abs(a[6][0] - b[6][0])
            size = abs(a[5] - b[5]) / max(a[5], b[5])
            if dy > 0.05 * h or dx < 6 or dx > 0.6 * (x1 - x0) or size > 0.6:
                continue
            score = dy + size * 20 + abs(dx - 0.18 * (x1 - x0)) * 0.1
            if score < best_score:
                best, best_score = (a, b), score
    if not best:
        return []
    eyes = []
    for (idx, x, y, w, hh, a, c) in sorted(best, key=lambda e: e[1]):
        ring = np.zeros_like(mask)
        cv2.rectangle(ring, (int(x) - 6, int(y) - 6), (int(x + w) + 6, int(y + hh) + 6), 1, -1)
        cv2.rectangle(ring, (int(x) - 1, int(y) - 1), (int(x + w) + 1, int(y + hh) + 1), 0, -1)
        pix = img[(ring > 0) & (mask > 0) & (gray >= 80)]
        skin = np.median(pix, axis=0) if len(pix) else np.array([220, 230, 240])
        ink = np.median(img[lab == idx], axis=0)
        eyes.append({"box": (int(x), int(y), int(w), int(hh)), "skin": [float(v) for v in skin], "ink": [float(v) for v in ink]})
    return eyes


def _reddish(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return ((hsv[..., 0] < 12) | (hsv[..., 0] > 165)) & (hsv[..., 1] > 90) & (hsv[..., 2] > 60)


# A drawn mouth is at most this many eye-spacings wide / tall; anything bigger is skin or clothing.
MOUTH_MAX_W, MOUTH_MAX_H = 1.3, 0.9
# Lab distance from the face's own skin below which a "red" pixel is just warm skin.
SKIN_LIKE_DE = 28.0
# The least OWLv2 confidence for "a phone at the ear" (which makes a character speak).
PHONE_MIN_SCORE = 0.4


def _unlike_skin(img, skin_bgr):
    """Pixels clearly not the face's own skin colour (perceptual Lab distance)."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.int16)
    ref = cv2.cvtColor(np.uint8([[np.clip(skin_bgr, 0, 255)]]), cv2.COLOR_BGR2LAB)[0, 0].astype(np.int16)
    return np.linalg.norm(lab - ref, axis=2) > SKIN_LIKE_DE


def find_mouth(img, mask, eyes):
    """The mouth under the eyes: 'open' (red inside, the series style) or 'line' (a drawn stroke).

    Warm or brown skin passes the plain red test, so "red" here means red AND
    clearly unlike this face's own skin (sampled around its eyes), and a mouth
    is never bigger than a drawn one -- trial 2026-10-12: a brown-skinned
    background man's whole lower face was taken for an open mouth, and the
    talking animation painted a huge outlined oval over his chin.
    """
    c = [(e["box"][0] + e["box"][2] / 2, e["box"][1] + e["box"][3] / 2) for e in eyes]
    ex, ey = (c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2
    sp = abs(c[0][0] - c[1][0])
    x0, x1 = max(0, int(ex - 0.9 * sp)), int(ex + 0.9 * sp)
    y0, y1 = max(0, int(ey + 0.35 * sp)), int(ey + 1.5 * sp)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    face_skin = np.median([e["skin"] for e in eyes], axis=0)
    reddish = _reddish(img) & _unlike_skin(img, face_skin)
    region = np.zeros_like(mask)
    region[y0:y1, x0:x1] = mask[y0:y1, x0:x1]

    def skin_around(x, y, w, h):
        ring = np.zeros_like(mask)
        cv2.rectangle(ring, (x - 8, y - 8), (x + w + 8, y + h + 8), 1, -1)
        cv2.rectangle(ring, (x - 2, y - 2), (x + w + 2, y + h + 2), 0, -1)
        pix = img[(ring > 0) & (mask > 0) & (gray > 110)]
        return [float(v) for v in (np.median(pix, axis=0) if len(pix) else (200, 210, 230))]

    # A red mouth wins over any nearby ink stroke.
    red = (reddish & (region > 0)).astype(np.uint8)
    rn, rlab, rst, _ = cv2.connectedComponentsWithStats(red, 8)
    reds = [i for i in range(1, rn) if rst[i, cv2.CC_STAT_AREA] >= max(12, 0.015 * sp * sp)]
    if reds:
        i = max(reds, key=lambda j: rst[j, cv2.CC_STAT_AREA])
        grown = cv2.dilate((rlab == i).astype(np.uint8), np.ones((15, 15), np.uint8))
        mm = (grown > 0) & ((gray < 90) | reddish) & (region > 0)
        ys, xs = np.nonzero(mm)
        x, y, w, h = int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        if w <= MOUTH_MAX_W * sp and h <= MOUTH_MAX_H * sp:
            inside = img[(rlab == i)]
            return {"box": (x, y, w, h), "kind": "open", "cover": cv2.dilate(mm.astype(np.uint8), np.ones((13, 13), np.uint8)),
                    "fill": [float(v) for v in np.median(inside, axis=0)], "skin": skin_around(x, y, w, h), "spacing": float(sp)}
        # Too big for a drawn mouth: not an open mouth; look for a drawn line instead.
    cand = (((gray < 90) | reddish) & (region > 0)).astype(np.uint8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(cand, 8)
    best = None
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 12 or w < 0.15 * sp or w > MOUTH_MAX_W * sp or h > MOUTH_MAX_H * sp:
            continue
        d = abs(cen[i][0] - ex) + 0.3 * abs(cen[i][1] - (ey + 0.9 * sp))
        if best is None or d < best[0]:
            best = (d, int(x), int(y), int(w), int(h))
    if not best:
        return None
    _, x, y, w, h = best
    return {"box": (x, y, w, h), "kind": "line", "skin": skin_around(x, y, w, h), "spacing": float(sp)}


def analyse(sq: np.ndarray) -> dict:
    """Everything that can move in this picture, found once."""
    from PIL import Image
    pil = Image.fromarray(cv2.cvtColor(sq, cv2.COLOR_BGR2RGB))
    cands = []
    for m in character_masks(pil):
        ys, xs = np.nonzero(m)
        if not len(ys):
            continue
        box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        cands.append((m, box, find_eyes(sq, m, box)))
    # One per person: the detector often returns a person as head, torso and
    # torso-plus-furniture. Faces first, tightest first; skip mostly-covered ones.
    cands.sort(key=lambda c: (0 if c[2] else 1, int((c[0] > 0).sum())))
    # A phone at the ear makes a character a speaker, so only a confident one counts:
    # trial 2026-10-12, a long orange braid scored 0.25 as "a mobile phone" (a real handset: 0.64).
    phones = [b for b, s in owl_boxes(pil, ["a telephone handset", "a mobile phone"], 0.2) if s >= PHONE_MIN_SCORE]
    hand_boxes = [b for b, _ in owl_boxes(pil, ["a cartoon hand", "a hand"], 0.12)]
    union = np.zeros(sq.shape[:2], np.uint8)
    chars = []
    for m, box, eyes in cands:
        area = int((m > 0).sum())
        if not eyes or not area or ((m > 0) & (union > 0)).sum() / area > 0.4:
            continue
        union |= m
        mouth = find_mouth(sq, m, eyes)
        sp = max(1.0, eyes[1]["box"][0] - eyes[0]["box"][0])
        ey = eyes[0]["box"][1]
        hx0, hx1, hy0, hy1 = eyes[0]["box"][0] - 1.4 * sp, eyes[1]["box"][0] + 1.6 * sp, ey - 1.6 * sp, ey + 2.0 * sp
        on_phone = any(b[0] < hx1 and b[2] > hx0 and b[1] < hy1 and b[3] > hy0 for b in phones)
        speaking = bool(mouth and (mouth["kind"] == "open" or on_phone))
        hands = []
        if speaking:
            for hb in hand_boxes:
                cx, cy = (hb[0] + hb[2]) / 2, (hb[1] + hb[3]) / 2
                inside = box[0] <= cx <= box[2] and box[1] <= cy <= box[3]
                near_head = hx0 - sp <= cx <= hx1 + sp and hy0 <= cy <= hy1 + sp  # e.g. holding the phone
                if not inside or near_head or (hb[2] - hb[0]) * (hb[3] - hb[1]) > 0.04 * S * S:
                    continue
                hm = sam_mask(pil, hb, (cx, cy)) & (m > 0)
                if hm.sum() < 150:
                    continue
                bx = (box[0] + box[2]) / 2
                hands.append({"mask": hm.astype(np.uint8), "wrist": (float(hb[0] if cx > bx else hb[2]), float(cy))})
        chars.append({"eyes": eyes, "mouth": mouth, "speaking": speaking, "hands": hands})
    # The still base: speaking hands painted out, so a moved hand leaves no double.
    allhands = np.zeros(sq.shape[:2], np.uint8)
    for c in chars:
        for h in c["hands"]:
            allhands |= h["mask"]
    base = cv2.inpaint(sq, cv2.dilate(allhands * 255, np.ones((9, 9), np.uint8)), 7, cv2.INPAINT_TELEA) if allhands.any() else sq.copy()
    return {"sq": sq, "base": base, "chars": chars}


def summary(a: dict) -> list:
    return [{"eyes": len(c["eyes"]), "mouth": c["mouth"]["kind"] if c["mouth"] else None,
             "speaking": c["speaking"], "hands": len(c["hands"])} for c in a["chars"]]


# ------------------------------------------------------------------ motion

def blink_amount(t: float, seed: int) -> float:
    """A blink every ~2.5-4.5 s (per character): 0.12 s closing, 0.12 s opening."""
    rng = np.random.default_rng(seed)
    for bt in np.cumsum(rng.uniform(2.5, 4.5, 60)) - rng.uniform(0, 2):
        d = t - bt
        if 0 <= d < 0.24:
            return min(1.0, d / 0.1) if d < 0.12 else max(0.0, 1 - (d - 0.12) / 0.12)
        if d < 0:
            break
    return 0.0


def draw_blink(img, eyes, amount):
    """amount 0..1: lids close over the dot from top and bottom; fully closed is an ink arc."""
    if amount <= 0:
        return
    for e in eyes:
        x, y, w, h = e["box"]
        cy = y + h // 2
        keep = int(round(h * (1 - amount) / 2))
        cv2.rectangle(img, (x - 2, y - 2), (x + w + 1, cy - keep), e["skin"], -1)
        cv2.rectangle(img, (x - 2, cy + keep), (x + w + 1, y + h + 1), e["skin"], -1)
        if amount > 0.7:
            cv2.ellipse(img, (x + w // 2, cy), (w // 2 + 2, max(2, h // 6)), 0, 0, 180, e["ink"], max(2, h // 5), cv2.LINE_AA)


def draw_mouth(img, mouth, o):
    """o = 0 closed .. 1 open. Below 0.3: closed lips (an ink line)."""
    x, y, w, h = mouth["box"]
    cxm, cym = x + w / 2, y + h / 2
    if mouth["kind"] == "open":
        if o > 0.95:
            return  # fully open: exactly as drawn
        img[mouth["cover"] > 0] = mouth["skin"]
        if o < 0.3:
            cv2.line(img, (int(x + 0.12 * w), int(cym)), (int(x + 0.88 * w), int(cym)), (30, 30, 30), max(2, h // 6), cv2.LINE_AA)
            return
        ax, ay = max(3, int(0.42 * w)), max(2, int(0.5 * h * (0.3 + 0.7 * o)))
        cv2.ellipse(img, (int(cxm), int(cym)), (ax, ay), 0, 0, 360, mouth["fill"], -1, cv2.LINE_AA)
        cv2.ellipse(img, (int(cxm), int(cym)), (ax, ay), 0, 0, 360, (30, 30, 30), max(2, h // 7), cv2.LINE_AA)
    else:
        if o < 0.08:
            return
        # A wide, shallow opening hanging from the drawn lip line.
        ow, oh = max(6, int(0.7 * w)), max(2, int(0.2 * mouth["spacing"] * o))
        cv2.ellipse(img, (int(cxm), int(round(cym))), (ow // 2, oh), 0, 0, 180, (50, 45, 150), -1, cv2.LINE_AA)
        cv2.ellipse(img, (int(cxm), int(round(cym))), (ow // 2, oh), 0, 0, 180, (30, 30, 30), 2, cv2.LINE_AA)


def draw_hand(img, sq, hand, angle_deg, shift):
    M = cv2.getRotationMatrix2D(hand["wrist"], angle_deg, 1.0)
    M[1, 2] += shift
    moved = cv2.warpAffine(sq, M, (S, S), flags=cv2.INTER_LINEAR)
    mm = cv2.warpAffine(hand["mask"] * 255, M, (S, S), flags=cv2.INTER_LINEAR)
    a = (cv2.GaussianBlur(mm, (3, 3), 0).astype(np.float32) / 255)[..., None]
    img[:] = (img * (1 - a) + moved * a).astype(np.uint8)


def frame(a: dict, t: float, o: float, emph: float, seed: int) -> np.ndarray:
    img = a["base"].copy()
    for k, c in enumerate(a["chars"]):
        for j, h in enumerate(c["hands"]):
            ang = 5.0 * emph * math.sin(2 * math.pi * 0.9 * t + j * 1.7 + k)
            draw_hand(img, a["sq"], h, ang, -4.0 * emph * abs(math.sin(2 * math.pi * 0.9 * t + j)))
        draw_blink(img, c["eyes"], blink_amount(t, seed + k))
        if c["speaking"] and c["mouth"]:
            draw_mouth(img, c["mouth"], o)
    return img


# ------------------------------------------------------------------ service entry

_cache: "OrderedDict[str, dict]" = OrderedDict()
_cache_lock = threading.Lock()


def analysed(png: bytes) -> dict:
    key = hashlib.sha256(png).hexdigest()
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    sq = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if sq is None or sq.shape[:2] != (S, S):
        raise ValueError(f"expected a {S}x{S} image, got {None if sq is None else sq.shape[:2]}")
    a = analyse(sq)
    with _cache_lock:
        _cache[key] = a
        while len(_cache) > 24:
            _cache.popitem(last=False)
    return a


def render_clip(png: bytes, frames: int, start_frame: int, envelope: list, seed: int) -> tuple[bytes, list]:
    """`frames` frames of the animated picture as an H.264 MP4 (1080x1080, 30 fps)."""
    if not 1 <= frames <= 30 * 60:
        raise ValueError("frames must be 1..1800")
    a = analysed(png)
    env = np.clip(np.asarray(envelope + [0.0] * max(0, frames - len(envelope)), np.float32)[:frames], 0, 1)
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "clip.mp4"
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{S}x{S}", "-r", str(FPS),
                                "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", str(out)],
                               stdin=subprocess.PIPE)
        try:
            for f in range(frames):
                emph = float(env[max(0, f - 8):f + 8].mean())  # slower "emphasis" for gestures
                enc.stdin.write(frame(a, (start_frame + f) / FPS, float(env[f]), emph, seed).tobytes())
        finally:
            enc.stdin.close()
            code = enc.wait()
        if code != 0:
            raise RuntimeError(f"ffmpeg exited {code}")
        return out.read_bytes(), summary(a)
