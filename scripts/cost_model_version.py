"""`COST_MODEL_VERSION`, read from the TypeScript that defines it.

`src/routing/types.ts` is the single source of truth. The builder stamps it into every cell
manifest and `package_cells.ts` refuses a mismatch — but that check fires at packaging time,
after a full 40-cell build, so the Python side reads the value rather than repeating it.
"""

import re
from pathlib import Path

TYPES_FILE = Path(__file__).resolve().parent.parent / "src/routing/types.ts"
_PATTERN = re.compile(r"^export const COST_MODEL_VERSION = (\d+);", re.MULTILINE)


def cost_model_version() -> int:
    match = _PATTERN.search(TYPES_FILE.read_text())
    if not match:
        raise RuntimeError(f"No COST_MODEL_VERSION declaration in {TYPES_FILE}")
    return int(match.group(1))


COST_MODEL_VERSION = cost_model_version()
