"""Preserve Mapterhorn's upstream attribution alongside generated packs."""

import json
from pathlib import Path

import httpx

path = Path("data/terrain/attribution.json")
if not path.exists():
    response = httpx.get("https://download.mapterhorn.com/attribution.json", timeout=30)
    response.raise_for_status()
    value = response.json()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2))
print(f"Attribution saved in {path}")
