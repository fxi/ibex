"""The one `DATA_VERSION`, read from the TypeScript that defines it.

`src/offline/version.ts` is the single source of truth (docs/data-format.md). The publish
and verify scripts read it here rather than keeping copies: a copy left behind at a bump is
how a promote points live clients at the wrong tree, and how a prune deletes the tree those
clients are still reading.
"""

import re
from pathlib import Path

VERSION_FILE = Path(__file__).resolve().parent.parent / "src/offline/version.ts"
_PATTERN = re.compile(r"^export const DATA_VERSION = (\d+);", re.MULTILINE)


def data_version() -> int:
    match = _PATTERN.search(VERSION_FILE.read_text())
    if not match:
        raise RuntimeError(f"No DATA_VERSION declaration in {VERSION_FILE}")
    return int(match.group(1))


DATA_VERSION = data_version()
