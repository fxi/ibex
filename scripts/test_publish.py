"""Publication layout and verification, against the checked-in synthetic release."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from data_version import DATA_VERSION, data_version
from publish_release import collect, conflicts, pointer, release_root

FIXTURE = Path(__file__).resolve().parent.parent / "tests/fixtures/data/v1"


class DataVersionSource(unittest.TestCase):
    """The Python side must not keep its own copy: a stale one prunes the live tree."""

    def test_reads_the_typescript_declaration(self):
        self.assertIsInstance(DATA_VERSION, int)
        self.assertGreaterEqual(DATA_VERSION, 1)
        self.assertEqual(DATA_VERSION, data_version())

    def test_matches_what_the_fixture_release_was_built_with(self):
        pointer_file = json.loads((FIXTURE / "latest.json").read_text())
        self.assertEqual(pointer_file["dataVersion"], DATA_VERSION)


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


class FakeS3:
    """Just enough of the client for the publication preflight: HEAD and its 404."""

    class exceptions:
        class ClientError(Exception):
            def __init__(self, code):
                super().__init__(code)
                self.response = {"Error": {"Code": code}}

    def __init__(self, sizes):
        self.sizes = sizes

    def head_object(self, Bucket, Key):
        if Key not in self.sizes:
            raise self.exceptions.ClientError("404")
        return {"ContentLength": self.sizes[Key]}


class ImmutablePublication(unittest.TestCase):
    """A release id names one set of bytes for good; republishing must not write over it."""

    BASE = "data/v1/releases/r"
    uploads = [
        (Path("a.ibx"), "9-264-181/graph.ibx", 10),
        (Path("b.json"), "catalogue.json", 4),
    ]

    def test_an_unpublished_release_has_nothing_to_clash_with(self):
        self.assertEqual(conflicts(FakeS3({}), "ibex", self.BASE, self.uploads), [])

    def test_republishing_the_same_bytes_is_not_a_conflict(self):
        client = FakeS3({f"{self.BASE}/9-264-181/graph.ibx": 10, f"{self.BASE}/catalogue.json": 4})
        self.assertEqual(conflicts(client, "ibex", self.BASE, self.uploads), [])

    def test_different_content_under_the_same_id_is_refused(self):
        client = FakeS3({f"{self.BASE}/9-264-181/graph.ibx": 11})
        self.assertEqual(
            conflicts(client, "ibex", self.BASE, self.uploads), ["9-264-181/graph.ibx"]
        )

    def test_an_interrupted_upload_still_resumes(self):
        client = FakeS3({f"{self.BASE}/9-264-181/graph.ibx": 10})
        self.assertEqual(conflicts(client, "ibex", self.BASE, self.uploads), [])


if __name__ == "__main__":
    unittest.main()
