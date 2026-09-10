"""OSM-derived profile signals; distances use a local metric projection."""

import math
from collections import defaultdict

from shapely import make_valid
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, transform, unary_union
from shapely.prepared import prep

URBAN_LANDUSE = {"residential", "commercial", "industrial", "retail", "garages", "construction"}
METERS_LAT = 111320
METERS_LON = METERS_LAT * math.cos(math.radians(46.2))


def project(geometry):
    return transform(lambda x, y: (x * METERS_LON, y * METERS_LAT), geometry)


def tagged_polygons(elements, matches):
    polygons = []
    for element in elements:
        if not matches(element.get("tags", {})):
            continue
        if element["type"] == "way":
            coords = [(p["lon"], p["lat"]) for p in element.get("geometry", []) if "lon" in p]
            if len(coords) > 3 and coords[0] == coords[-1]:
                polygons.append(make_valid(Polygon(coords)))
        elif element["type"] == "relation":
            outer, inner = [], []
            for member in element.get("members", []):
                coords = [(p["lon"], p["lat"]) for p in member.get("geometry", []) if "lon" in p]
                if len(coords) > 1:
                    (inner if member.get("role") == "inner" else outer).append(LineString(coords))
            rings = list(polygonize(outer))
            if rings:
                area = unary_union(rings)
                holes = list(polygonize(inner))
                if holes:
                    area = area.difference(unary_union(holes))
                polygons.append(make_valid(area))
    return polygons


def urban_index(elements):
    # The buffer includes streets between land-use polygons, not just house plots.
    areas = [project(p).buffer(40) for p in tagged_polygons(elements, lambda t: t.get("landuse") in URBAN_LANDUSE)]
    radii = {"city": 1500, "town": 700, "village": 250}
    for e in elements:
        radius = radii.get(e.get("tags", {}).get("place"))
        if e["type"] == "node" and radius and "lon" in e:
            areas.append(project(Point(e["lon"], e["lat"])).buffer(radius))
    return prep(unary_union(areas))


def urban_fraction(coords, tags, index):
    if tags.get("highway") in {"residential", "living_street"}:
        return 1.0
    line = project(LineString(coords))
    if not line.length or not index.intersects(line):
        return 0.0
    if index.covers(line):
        return 1.0
    # Only boundary-crossing roads need sampling. Avoid intersecting every edge
    # with the entire regional multipolygon, which is prohibitively expensive.
    samples = max(2, math.ceil(line.length / 30))
    hits = sum(index.covers(line.interpolate(i / samples, normalized=True)) for i in range(samples + 1))
    return round(hits / (samples + 1), 3)


def cycling_memberships(elements):
    """Member roles are relative to OSM way direction; proposals are not networks."""
    memberships = defaultdict(set)
    relations = {e["id"]: e for e in elements if e["type"] == "relation"}

    def visit(relation, directions, seen):
        if relation["id"] in seen:
            return
        seen = seen | {relation["id"]}
        for m in relation.get("members", []):
            role = m.get("role", "")
            allowed = directions & ({role} if role in {"forward", "backward"} else {"forward", "backward"})
            if m["type"] == "way":
                memberships[m["ref"]].update(allowed)
            elif m["type"] == "relation" and m["ref"] in relations:
                visit(relations[m["ref"]], allowed, seen)

    for e in relations.values():
        t = e.get("tags", {})
        if t.get("type") == "route" and t.get("route") in {"bicycle", "mtb"} and t.get("state") not in {"proposed", "planned", "construction"} and t.get("signposted") != "no":
            visit(e, {"forward", "backward"}, set())
    return memberships


def on_cycling_network(way, direction, memberships):
    t = way["tags"]
    legacy = any(t.get(key) == "yes" or t.get(f"{key}_ref") for key in ("lcn", "rcn", "ncn", "icn"))
    return int(bool(legacy or direction in memberships[way["id"]]))


def duration_seconds(value):
    if not value:
        return None
    try:
        parts = [int(p) for p in value.split(":")]
        seconds = parts[0] * 60 if len(parts) == 1 else parts[0] * 3600 + parts[1] * 60 + (parts[2] if len(parts) == 3 else 0)
        return seconds if len(parts) <= 3 and all(p >= 0 for p in parts) and 0 < seconds <= 7 * 86400 else None
    except (ValueError, IndexError):
        return None


def ferry_ways(elements, distance):
    """Apply relation metadata only to water ways, never road approaches."""
    ways = {e["id"]: e for e in elements if e["type"] == "way"}
    metadata = {}
    for r in sorted((e for e in elements if e["type"] == "relation" and e.get("tags", {}).get("route") == "ferry"), key=lambda e: e["id"]):
        members = [ways[m["ref"]] for m in r.get("members", []) if m["type"] == "way" and m["ref"] in ways and (ways[m["ref"]].get("tags", {}).get("route") == "ferry" or "highway" not in ways[m["ref"]].get("tags", {}))]
        lengths = {}
        for w in members:
            coords = [(p["lon"], p["lat"]) for p in w.get("geometry", []) if "lon" in p]
            lengths[w["id"]] = sum(distance(a, b) for a, b in zip(coords, coords[1:]))
        total = sum(lengths.values())
        duration = duration_seconds(r.get("tags", {}).get("duration"))
        for w in members:
            if w["id"] in metadata:
                continue
            tags = {**r.get("tags", {}), **w.get("tags", {}), "route": "ferry"}
            seconds = duration_seconds(w.get("tags", {}).get("duration"))
            if seconds is None and duration and total:
                seconds = duration * lengths[w["id"]] / total
            metadata[w["id"]] = (tags, f"relation/{r['id']}", seconds)
    for w in ways.values():
        if w.get("tags", {}).get("route") == "ferry" and w["id"] not in metadata:
            metadata[w["id"]] = (w["tags"], f"way/{w['id']}", duration_seconds(w["tags"].get("duration")))
    return metadata
