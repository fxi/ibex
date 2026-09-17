"""Download the custom style, keeping API credentials out of the saved asset."""

import json
from pathlib import Path

import httpx
from dotenv import dotenv_values

root = Path(__file__).resolve().parent.parent
key = (
    dotenv_values(root / ".env", interpolate=False).get("VITE_MAPTILER_API_KEY") or ""
).strip()
if not key:
    raise SystemExit("Set VITE_MAPTILER_API_KEY in .env first.")
url = "https://api.maptiler.com/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json"
response = httpx.get(
    url,
    params={"key": key},
    headers={"Referer": "http://localhost:5173/ibex/"},
    timeout=60,
)
if response.status_code != 200:
    raise SystemExit(
        f"Style download failed (HTTP {response.status_code}): {response.text[:500].replace(key, '[redacted]')}"
    )
style = response.json()
text = json.dumps(style, ensure_ascii=False, indent=2).replace(
    key, "INSERT_YOUR_OWN_API_KEY"
)
(root / "src/map/custom-style.json").write_text(text + "\n")
print(
    f"Saved custom style: {len(style.get('layers', []))} layers; sources: {list(style.get('sources', {}))}"
)
