"""Face logic on synthetic series-style faces (no models needed): python -m unittest"""
import unittest

import cv2
import numpy as np

import animate

SKIN = (200, 225, 245)  # BGR


def face(mouth: str):
    """A round cartoon head: two dot eyes, and either a red open mouth or a black frown line."""
    img = np.full((animate.S, animate.S, 3), (120, 180, 230), np.uint8)
    cv2.circle(img, (540, 400), 160, SKIN, -1)
    cv2.circle(img, (540, 400), 160, (20, 20, 20), 8)
    cv2.rectangle(img, (440, 560), (640, 1000), (160, 140, 40), -1)  # body
    for x in (490, 590):
        cv2.ellipse(img, (x, 380), (11, 16), 0, 0, 360, (15, 15, 15), -1)
    if mouth == "open":
        cv2.ellipse(img, (540, 470), (34, 16), 0, 0, 360, (40, 40, 190), -1)
        cv2.ellipse(img, (540, 470), (34, 16), 0, 0, 360, (20, 20, 20), 6)
    else:
        cv2.ellipse(img, (540, 485), (30, 12), 0, 200, 340, (20, 20, 20), 6)
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.circle(mask, (540, 400), 166, 1, -1)
    cv2.rectangle(mask, (440, 560), (640, 1000), 1, -1)
    ys, xs = np.nonzero(mask)
    return img, mask, (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


class FaceTests(unittest.TestCase):
    def test_eyes_are_the_two_dots(self):
        img, mask, box = face("open")
        eyes = animate.find_eyes(img, mask, box)
        self.assertEqual(len(eyes), 2)
        self.assertLess(abs(eyes[0]["box"][0] + eyes[0]["box"][2] / 2 - 490), 4)
        self.assertLess(abs(eyes[1]["box"][0] + eyes[1]["box"][2] / 2 - 590), 4)

    def test_red_mouth_is_open_and_a_frown_is_a_line(self):
        for kind in ("open", "line"):
            img, mask, box = face(kind)
            mouth = animate.find_mouth(img, mask, animate.find_eyes(img, mask, box))
            self.assertIsNotNone(mouth)
            self.assertEqual(mouth["kind"], kind)

    def test_blinks_close_the_eyes_then_open_them(self):
        img, mask, box = face("line")
        eyes = animate.find_eyes(img, mask, box)
        closed = img.copy()
        animate.draw_blink(closed, eyes, 1.0)
        x, y, w, h = eyes[0]["box"]
        self.assertGreater(closed[y + 1, x + w // 2].mean(), 150, "the dot is covered by skin")
        untouched = img.copy()
        animate.draw_blink(untouched, eyes, 0.0)
        self.assertTrue(np.array_equal(untouched, img))

    def test_blink_timing(self):
        ts = np.arange(0, 30, 1 / animate.FPS)
        amounts = np.array([animate.blink_amount(t, 7) for t in ts])
        starts = np.flatnonzero((amounts[1:] > 0) & (amounts[:-1] == 0))
        self.assertTrue(5 <= len(starts) <= 13, f"one blink every 2.5-4.5 s, got {len(starts)} in 30 s")
        self.assertLessEqual(int((amounts > 0).sum()) / len(starts), 8, "each blink lasts about a quarter second")
        self.assertNotEqual([animate.blink_amount(t, 7) for t in ts[:200]], [animate.blink_amount(t, 8) for t in ts[:200]],
                            "characters blink at their own times")

    def test_open_mouth_closes_to_a_line_and_reopens_as_drawn(self):
        img, mask, box = face("open")
        mouth = animate.find_mouth(img, mask, animate.find_eyes(img, mask, box))
        closed = img.copy()
        animate.draw_mouth(closed, mouth, 0.0)
        red = (closed[..., 2] > 150) & (closed[..., 1] < 80)
        self.assertEqual(int(red.sum()), 0, "no red left when the lips are closed")
        full = img.copy()
        animate.draw_mouth(full, mouth, 1.0)
        self.assertTrue(np.array_equal(full, img), "fully open is exactly the drawing")

    def test_a_drawn_line_mouth_opens_below_it_when_talking(self):
        img, mask, box = face("line")
        mouth = animate.find_mouth(img, mask, animate.find_eyes(img, mask, box))
        talk = img.copy()
        animate.draw_mouth(talk, mouth, 1.0)
        self.assertGreater(int(np.abs(talk.astype(int) - img.astype(int)).sum()), 0)
        quiet = img.copy()
        animate.draw_mouth(quiet, mouth, 0.0)
        self.assertTrue(np.array_equal(quiet, img), "silent: the mouth stays as drawn")


if __name__ == "__main__":
    unittest.main()
