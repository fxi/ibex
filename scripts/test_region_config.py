"""The release layout the Python pipeline writes and the TypeScript side reads."""

import re
import unittest
from pathlib import Path

from region_config import RELEASE_ROOT, describe, release_cell_ids

LOCAL_RELEASE = Path(__file__).resolve().parent / "local_release.ts"


class ReleaseRoot(unittest.TestCase):
    def test_matches_the_typescript_default(self):
        """A drift here is a pipeline whose stages write and read different directories."""
        match = re.search(
            r'export const DEFAULT_RELEASE_ROOT = "([^"]+)"', LOCAL_RELEASE.read_text()
        )
        self.assertIsNotNone(match, "DEFAULT_RELEASE_ROOT not found in local_release.ts")
        self.assertEqual(RELEASE_ROOT, match.group(1))


class Window(unittest.TestCase):
    def test_describes_every_cell_it_counts(self):
        described = describe()
        self.assertEqual(described["cells"], len(described["cellIds"]))
        self.assertEqual(described["cellIds"], release_cell_ids())
        self.assertEqual(len(set(described["cellIds"])), described["cells"])


if __name__ == "__main__":
    unittest.main()
