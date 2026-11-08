"""Image-level invariants without downloading or invoking SAM weights."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tryon_local.segmentation import focus_garment


class GarmentFocusTests(unittest.TestCase):
    def test_preserves_garment_and_original_and_removes_surroundings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = np.full((80, 60, 3), (180, 90, 120), dtype=np.uint8)
            original[20:60, 15:45] = (40, 180, 230)
            source = root / "product.png"
            Image.fromarray(original).save(source)
            mask = np.zeros((80, 60), dtype=bool)
            mask[20:60, 15:45] = True
            before = source.read_bytes()
            with patch("tryon_local.segmentation.segment", return_value=(mask, .98)):
                result = focus_garment(source, "t-shirt", root / "derived")
            focus = np.asarray(Image.open(result["focus"]))
            reference = np.asarray(Image.open(result["reference"]))
            self.assertTrue(np.array_equal(focus[mask], original[mask]))
            self.assertTrue(np.array_equal(reference[mask], original[mask]))
            self.assertTrue((reference[~mask] == 242).all())
            self.assertLess(focus[~mask].mean(), original[~mask].mean())
            self.assertEqual(source.read_bytes(), before)

    def test_missing_or_unconfident_masks_do_not_pass_through_original(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "product.png"
            Image.new("RGB", (80, 80), "white").save(source)
            for mask, score in [(None, 0), (np.zeros((80, 80), bool), .9), (np.ones((80, 80), bool), .99)]:
                with self.subTest(score=score), patch("tryon_local.segmentation.segment", return_value=(mask, score)):
                    with self.assertRaises(ValueError):
                        focus_garment(source, "pants", Path(temp) / "derived")


if __name__ == "__main__":
    unittest.main()
