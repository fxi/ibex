"""Synthetic preprocessing checks; run with uv run python -m unittest discover -s scripts -p 'test_*.py'."""

import unittest

from build_region import directions, permitted
from prepare_tracks import clip, portions


class DataTests(unittest.TestCase):
    def test_boundary_crossing(self):
        result = clip([5.7, 46.1], [6, 46.1])
        self.assertEqual(result[0][0], [5.8, 46.1])
        self.assertTrue(result[1])

    def test_deduplication(self):
        parts = list(portions([[6.1, 46.1], [6.1, 46.1], [6.101, 46.1]]))
        self.assertEqual(len(parts), 1)
        self.assertEqual(len(parts[0][0]), 2)

    def test_gap_split(self):
        parts = list(portions([[6.1, 46.1], [6.101, 46.1], [6.2, 46.1], [6.201, 46.1]]))
        self.assertEqual(len(parts), 2)
        self.assertIn("gps-gap", parts[0][1])

    def test_bicycle_access(self):
        self.assertFalse(permitted({"highway": "motorway"}))
        self.assertTrue(permitted({"highway": "steps"}))
        self.assertFalse(permitted({"highway": "steps", "bicycle": "no"}))
        self.assertFalse(permitted({"route": "ferry", "bicycle": "no"}))
        self.assertTrue(permitted({"route": "ferry", "bicycle": "yes"}))
        self.assertTrue(permitted({"highway": "path", "bicycle": "dismount"}))
        self.assertTrue(
            permitted({"highway": "path", "access": "no", "bicycle": "yes"})
        )
        self.assertFalse(
            permitted(
                {"highway": "path", "bicycle:conditional": "yes @ (sunrise-sunset)"}
            )
        )

    def test_oneway_exception(self):
        self.assertEqual(directions({"oneway": "yes"}), (True, False))
        self.assertEqual(
            directions({"oneway": "yes", "oneway:bicycle": "no"}), (True, True)
        )
        self.assertEqual(directions({"oneway": "-1"}), (False, True))


if __name__ == "__main__":
    unittest.main()
