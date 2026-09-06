"""Build the water multipolygons needed by a readable Geneva basin basemap."""

import json
from pathlib import Path

import httpx
from shapely.geometry import LineString, mapping
from shapely.ops import polygonize, unary_union

path = Path("data/osm-water.json")
if not path.exists():
    response = httpx.get(
        "https://overpass.kumi.systems/api/interpreter",
        params={
            "data": "[out:json][timeout:120];relation[natural=water](45.95,5.8,46.45,6.55);out geom;"
        },
        timeout=180,
    )
    response.raise_for_status()
    value = response.json()
    if value.get("remark"):
        raise RuntimeError(value["remark"])
    path.write_bytes(response.content)
features = []
for relation in json.loads(path.read_bytes())["elements"]:
    outer = []
    inner = []
    for member in relation.get("members", []):
        geometry = member.get("geometry", [])
        coords = [(p["lon"], p["lat"]) for p in geometry if "lon" in p]
        if len(coords) < 2:
            continue
        (inner if member.get("role") == "inner" else outer).append(LineString(coords))
    rings = list(polygonize(outer))
    holes = list(polygonize(inner))
    if not rings:
        continue
    water = unary_union(rings)
    if holes:
        water = water.difference(unary_union(holes))
    features.append(
        {"type": "Feature", "properties": {"kind": "water"}, "geometry": mapping(water)}
    )
Path("data/water.geojson").write_text(
    json.dumps(
        {"type": "FeatureCollection", "features": features}, separators=(",", ":")
    )
)
print(f"Prepared {len(features)} water multipolygons")
