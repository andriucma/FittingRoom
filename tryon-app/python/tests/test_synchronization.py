"""Timing and file-preservation checks; no cloud calls or pose model downloads."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tryon_local import synchronization as sync


def features(count, exponent=1, duration=4):
    phase = np.linspace(0, 1, count) ** exponent * 2 * np.pi
    orientation = np.stack([np.cos(phase), np.sin(phase)], axis=1)
    return {"body": np.concatenate([orientation, np.sin(phase[:, None] + [0, .4, .8])], axis=1),
            "orientation": orientation, "time": np.arange(count) * duration / count,
            "direction": 1, "progress": np.degrees(phase)}


class SynchronizationTests(unittest.TestCase):
    def test_matches_nonuniform_turn_with_different_frame_rates(self):
        left, right = features(120), features(96, 1.6)
        mapping, metrics, improved = sync.align_features(left, right)
        self.assertTrue(improved)
        self.assertTrue(np.all(np.diff(mapping) >= 0))
        self.assertEqual(mapping[0], 0)
        self.assertEqual(mapping[-1], 95)
        self.assertLess(metrics["pose_error_after"], metrics["pose_error_before"] * .1)
        self.assertLess(metrics["median_angle_error_after_deg"], 5)
        self.assertLess(np.max(abs(mapping / 95 - np.linspace(0, 1, 120))), .36)

    def test_missing_person_rejects_pose_alignment(self):
        with self.assertRaisesRegex(ValueError, "reliable body poses"):
            sync.pose_features([{"pose": False} for _ in range(120)])

    def test_missing_generated_ending_is_excluded_instead_of_showing_drift(self):
        errors = np.r_[np.zeros(90), np.full(30, 90)]
        self.assertEqual(sync.shared_interval(errors), (0, 90))
        with self.assertRaisesRegex(ValueError, "shared pose interval"):
            sync.shared_interval(np.full(120, 90))

    def test_encoding_fallback_and_cache_preserve_inputs_and_use_source_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, generated = root / "source.mp4", root / "generated.mp4"
            for out, rate, duration in [(source, 30, 2), (generated, 24, 1)]:
                subprocess.run([sync._tool("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i",
                                f"color=c=blue:s=90x160:r={rate}:d={duration}", "-c:v", "libx264", str(out)], check=True)
            before = [hashlib.sha256(f.read_bytes()).hexdigest() for f in (source, generated)]
            compare, report = root / "compare.mp4", root / "sync.json"
            with patch.object(sync, "_measure", return_value=[]):
                result = sync.synchronize(source, generated, compare, report)
            self.assertEqual(result["method"], "timing-only")
            self.assertIn("reliable body poses", result["reason"])
            self.assertEqual(result["duration"], 2)
            meta = json.loads(subprocess.check_output([sync._tool("ffprobe"), "-v", "error", "-show_entries",
                                                       "stream=avg_frame_rate,nb_frames,duration", "-of", "json", str(compare)]))["streams"][0]
            self.assertEqual(meta["avg_frame_rate"], "30/1")
            self.assertEqual(int(meta["nb_frames"]), 60)
            self.assertAlmostEqual(float(meta["duration"]), 2, places=3)
            with patch.object(sync, "_measure", side_effect=AssertionError("cache was ignored")):
                self.assertEqual(sync.synchronize(source, generated, compare, report), result)
            self.assertEqual([hashlib.sha256(f.read_bytes()).hexdigest() for f in (source, generated)], before)
            # Exercise the actual frame selection/encoding path with known pose tracks.
            report.unlink()
            with patch.object(sync, "_measure", return_value=[]), patch.object(sync, "pose_features", side_effect=[features(60, duration=2), features(24, 1.6, duration=1)]):
                result = sync.synchronize(source, generated, compare, report)
            self.assertEqual(result["method"], "pose-dtw")
            self.assertEqual(result["frames"], 60)
            self.assertAlmostEqual(sync._probe(compare)[0], 2, places=3)

    def test_inputs_cannot_be_overwritten(self):
        with self.assertRaisesRegex(ValueError, "overwrite"):
            sync.synchronize(Path("source.mp4"), Path("generated.mp4"), Path("source.mp4"), Path("report.json"))


if __name__ == "__main__":
    unittest.main()
