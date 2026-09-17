"""Publication layout and verification, against the checked-in synthetic release."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from publish_release import collect, pointer, release_root

FIXTURE = Path(__file__).resolve().parent.parent / "tests/fixtures/data/v1"


class PublishLayout(unittest.TestCase):
    def test_keys_follow_the_versioned_layout(self):
        self.assertEqual(
            release_root("ibex", 1, "20260914-a3540b2d"),
            "ibex/data/v1/releases/20260914-a3540b2d",
        )
        self.assertEqual(release_root("", 2, "r"), "data/v2/releases/r")

    def test_pointer_matches_the_checked_in_fixture(self):
        expected = json.loads((FIXTURE / "latest.json").read_text())
        self.assertEqual(
            pointer(1, "fixture", "1970-01-01T00:00:00.000Z"), expected
        )

    def test_collect_verifies_and_uploads_the_catalogue_last(self):
        catalogue, uploads = collect(FIXTURE / "releases/fixture")
        self.assertEqual(catalogue["release"], "fixture")
        keys = [key for _, key, _ in uploads]
        self.assertEqual(keys[-1], "catalogue.json")
        self.assertIn("9-264-181/graph.ibx", keys)
        self.assertLess(
            keys.index("9-264-181/graph.ibx"), keys.index("9-264-181/manifest.json")
        )

    def test_collect_refuses_a_corrupted_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            copy = Path(temporary) / "fixture"
            shutil.copytree(FIXTURE / "releases/fixture", copy)
            graph = copy / "9-264-181/graph.ibx"
            data = bytearray(graph.read_bytes())
            data[0] ^= 1
            graph.write_bytes(bytes(data))
            with self.assertRaisesRegex(ValueError, "Integrity"):
                collect(copy)


if __name__ == "__main__":
    unittest.main()
