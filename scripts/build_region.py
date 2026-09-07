"""Build a deterministic, versioned OSM graph and self-contained regional map.

No intersections are inferred from geometry. OSM node IDs define connectivity.
Unsupported conditional access is conservatively excluded and counted.
"""

import argparse
import hashlib
import heapq
import io
import json
import math
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from PIL import Image
from prepare_tracks import BBOX, distance
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union
from shapely.prepared import prep
from terrain_profile import bilinear_height, way_profile, slice_profile

DENIED = {"no", "private", "use_sidepath"}
PAVED = {"asphalt", "concrete", "concrete:plates", "paving_stones", "paved"}


def permitted(tags):
    access = tags.get("bicycle", tags.get("vehicle", tags.get("access", "yes")))
    if access in DENIED or access == "dismount":
        return False
    if any(
        key in tags
        for key in ["bicycle:conditional", "access:conditional", "vehicle:conditional"]
    ):
        return False
    highway = tags.get("highway", "")
    if highway in {
        "construction",
        "proposed",
        "abandoned",
        "raceway",
        "steps",
        "elevator",
    }:
        return False
    if highway in {
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "footway",
        "pedestrian",
    } and tags.get("bicycle") not in {"yes", "designated", "permissive", "official"}:
        return False
    if tags.get("motorroad") == "yes" and tags.get("bicycle") not in {
        "yes",
        "designated",
    }:
        return False
    return bool(highway)


def directions(tags):
    direction = tags.get(
        "oneway:bicycle",
        tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no"),
    )
    if any(
        tags.get(k, "").startswith("opposite")
        for k in ["cycleway", "cycleway:left", "cycleway:right"]
    ):
        direction = "no"
    forward = direction != "-1" and tags.get("bicycle:forward") not in DENIED
    backward = (
        direction not in {"yes", "1", "true"}
        and tags.get("bicycle:backward") not in DENIED
    )
    return forward, backward


# Golden-gravel quality: how rewarding a surface is to ride, not just how rideable.
SURFACE_QUALITY = {
    "fine_gravel": 1.0,
    "compacted": 0.85,
    "gravel": 0.7,
    "unpaved": 0.5,
    "ground": 0.4,
    "dirt": 0.35,
    "cobblestone": 0.3,
    "grass": 0.2,
    "paved": 0.15,
    "sand": 0.0,
    "mud": 0.0,
    "rock": 0.0,
}
TRACK_QUALITY = {"grade1": 1.0, "grade2": 0.85, "grade3": 0.6, "grade4": 0.2, "grade5": 0.2}
SMOOTHNESS_QUALITY = {"excellent": 1.0, "good": 1.0, "intermediate": 0.85, "bad": 0.5}
QUALITY_HIGHWAYS = {"track", "path", "bridleway"}


def edge_quality(highway, surface, tags, stress):
    if highway not in QUALITY_HIGHWAYS:
        return 0.0
    surface_score = SURFACE_QUALITY.get(surface, 0.2)
    track_score = TRACK_QUALITY.get(tags.get("tracktype"), 0.7)
    smooth_score = SMOOTHNESS_QUALITY.get(tags.get("smoothness"), 0.6)
    return round(
        max(0.0, min(1.0, surface_score * track_score * smooth_score * (1 - 0.5 * stress))),
        3,
    )


def forest_polygons(elements):
    """Assemble forest/wood polygons from closed ways and multipolygon relations."""
    polygons = []
    for e in elements:
        tags = e.get("tags", {})
        if e["type"] != "way" or (tags.get("landuse") != "forest" and tags.get("natural") != "wood"):
            continue
        coords = [(p["lon"], p["lat"]) for p in e.get("geometry", []) if "lon" in p]
        if len(coords) > 3 and coords[0] == coords[-1]:
            polygons.append(Polygon(coords))
    for r in elements:
        tags = r.get("tags", {})
        if r["type"] != "relation" or (tags.get("landuse") != "forest" and tags.get("natural") != "wood"):
            continue
        outer, inner = [], []
        for member in r.get("members", []):
            coords = [(p["lon"], p["lat"]) for p in member.get("geometry", []) if "lon" in p]
            if len(coords) < 2:
                continue
            (inner if member.get("role") == "inner" else outer).append(LineString(coords))
        rings = list(polygonize(outer))
        holes = list(polygonize(inner))
        if not rings:
            continue
        area = unary_union(rings)
        if holes:
            area = area.difference(unary_union(holes))
        polygons.append(area)
    return polygons


def interpolate_polyline(coords, t, total_length):
    """Point at fraction t (0..1) along a polyline, by arc length."""
    if len(coords) == 1 or total_length <= 0:
        return coords[0]
    target = t * total_length
    covered = 0.0
    for a, b in zip(coords, coords[1:]):
        seg = distance(a, b)
        if seg == 0:
            continue
        if covered + seg >= target:
            frac = (target - covered) / seg
            return [a[0] + frac * (b[0] - a[0]), a[1] + frac * (b[1] - a[1])]
        covered += seg
    return coords[-1]


def edge_forest_fraction(coords, length, forest_geom):
    if forest_geom is None or length <= 0:
        return 0.0
    samples = max(2, math.ceil(length / 30))
    hits = sum(
        forest_geom.contains(Point(interpolate_polyline(coords, i / samples, length)))
        for i in range(samples + 1)
    )
    return round(hits / (samples + 1), 3)


def viewpoint_index(viewpoints, cell=0.001):
    index = defaultdict(list)
    for p in viewpoints:
        index[(math.floor(p[0] / cell), math.floor(p[1] / cell))].append(p)
    return index


def near_viewpoint(coords, index, cell=0.001, radius_m=60):
    for p in coords:
        cx, cy = math.floor(p[0] / cell), math.floor(p[1] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for vp in index.get((cx + dx, cy + dy), ()):
                    if distance(p, vp) <= radius_m:
                        return True
    return False


def tile_coord(p, z=12):
    n = 2**z
    x = (p[0] + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(p[1]))) / math.pi) / 2 * n
    return int(x), int(y), (x % 1) * 512, (y % 1) * 512


def terrain_samples(points, cache, enabled):
    if not enabled:
        return {}
    cache.mkdir(parents=True, exist_ok=True)
    tiles = {tile_coord(p)[:2] for p in points.values()}

    def fetch(key):
        x, y = key
        path = cache / f"12-{x}-{y}.webp"
        try:
            if not path.exists():
                response = httpx.get(
                    f"https://tiles.mapterhorn.com/12/{x}/{y}.webp", timeout=40
                )
                response.raise_for_status()
                Image.open(io.BytesIO(response.content)).verify()
                path.write_bytes(response.content)
            return key, Image.open(path).convert("RGB")
        except (httpx.HTTPError, OSError):
            return key, None

    with ThreadPoolExecutor(max_workers=4) as pool:
        images = dict(pool.map(fetch, sorted(tiles)))
    elevations = {}
    for id, p in points.items():
        x, y, px, py = tile_coord(p)
        img = images.get((x, y))
        if img:
            elevations[id] = bilinear_height(img, px, py)
    return elevations


def build(source, output, terrain=True):
    raw = json.loads(source.read_bytes())
    elements = raw["elements"]
    counts = Counter()
    ways = [
        e
        for e in elements
        if e["type"] == "way" and "highway" in e.get("tags", {}) and e.get("geometry")
    ]
    barriers = {
        e["id"]: e.get("tags", {})
        for e in elements
        if e["type"] == "node" and "barrier" in e.get("tags", {})
    }
    blocked = {
        id
        for id, t in barriers.items()
        if not permitted({"highway": "path", **t})
        or (
            t.get("barrier") in {"wall", "fence", "stile", "turnstile", "block"}
            and t.get("bicycle") not in {"yes", "designated"}
        )
    }
    # Conservatively remove from-ways for unsupported conditional restrictions.
    conditional_from = set()
    for r in elements:
        if r["type"] == "relation" and any(
            "conditional" in k for k in r.get("tags", {})
        ):
            conditional_from.update(
                m["ref"] for m in r.get("members", []) if m["role"] == "from"
            )
    roads = [
        w for w in ways if permitted(w["tags"]) and w["id"] not in conditional_from
    ]
    counts["excludedWays"] = len(ways) - len(roads)
    viewpoints = [
        (e["lon"], e["lat"])
        for e in elements
        if e["type"] == "node"
        and (
            e.get("tags", {}).get("tourism") == "viewpoint"
            or e.get("tags", {}).get("natural") == "peak"
        )
    ]
    vp_index = viewpoint_index(viewpoints)
    forest_shapes = forest_polygons(elements)
    forest_geom = prep(unary_union(forest_shapes)) if forest_shapes else None
    positions = {}
    usage = Counter()
    for way in roads:
        for id, p in zip(way["nodes"], way["geometry"]):
            if "lon" not in p:
                continue
            positions[id] = [p["lon"], p["lat"]]
            usage[id] += 1
    elevations = terrain_samples(positions, Path("data/terrain"), terrain)
    restrictions = []
    via_nodes = set()
    road_ids = {w["id"] for w in roads}
    for r in elements:
        t = r.get("tags", {})
        if r["type"] != "relation" or t.get("type") != "restriction":
            continue
        if "bicycle" in t.get("except", "").split(";"):
            continue
        kind = t.get("restriction:bicycle", t.get("restriction", ""))
        if not kind.startswith(("no_", "only_")):
            continue
        members = r.get("members", [])
        starts = [
            m["ref"] for m in members if m["role"] == "from" and m["type"] == "way"
        ]
        ends = [m["ref"] for m in members if m["role"] == "to" and m["type"] == "way"]
        via = [m for m in members if m["role"] == "via"]
        if not starts or not ends:
            continue
        for start in starts:
            for end in ends:
                sequence = (
                    [start] + [m["ref"] for m in via if m["type"] == "way"] + [end]
                )
                if not all(w in road_ids for w in sequence):
                    counts["restrictionsOutsideGraph"] += 1
                    continue
                rule = {
                    "ways": list(map(str, sequence)),
                    "only": kind.startswith("only_"),
                    "uTurn": kind.endswith("u_turn"),
                }
                node_via = [m["ref"] for m in via if m["type"] == "node"]
                if node_via:
                    rule["via"] = node_via[0]
                    via_nodes.add(node_via[0])
                restrictions.append(rule)
    kept = set(via_nodes) | set(barriers)
    for way in roads:
        kept.add(way["nodes"][0])
        kept.add(way["nodes"][-1])
    kept.update(id for id, count in usage.items() if count > 1)
    edges = []
    node_ids = set()
    for way in roads:
        tags = way["tags"]
        sequence = way["nodes"]
        if any(node not in positions for node in sequence):
            continue
        offsets, profile = way_profile(sequence, positions, elevations, tags.get("incline"))
        start = 0
        for i in range(1, len(sequence)):
            if sequence[i] not in kept and i < len(sequence) - 1:
                continue
            ids = sequence[start : i + 1]
            profile_start = offsets[start]
            profile_end = offsets[i]
            start = i
            if any(id not in positions for id in ids) or any(
                id in blocked for id in ids
            ):
                continue
            coords = [positions[id] for id in ids]
            # Keep the graph inside declared coverage; boundary connectors are retained only when fully covered.
            if any(
                not (BBOX[0] <= p[0] <= BBOX[2] and BBOX[1] <= p[1] <= BBOX[3])
                for p in coords
            ):
                continue
            lengths = [distance(a, b) for a, b in zip(coords, coords[1:])]
            length = sum(lengths)
            if length < 0.1:
                continue
            bridge = tags.get("bridge", "no") != "no"
            tunnel = tags.get("tunnel", "no") != "no"
            grade_samples = None if bridge or tunnel else slice_profile(profile, profile_start, profile_end)
            highway = tags["highway"]
            stress = {
                "primary": 0.95,
                "primary_link": 0.95,
                "secondary": 0.8,
                "secondary_link": 0.8,
                "tertiary": 0.55,
                "residential": 0.2,
                "service": 0.15,
                "unclassified": 0.3,
                "living_street": 0.05,
                "cycleway": 0.02,
            }.get(highway, 0.08)
            if any(
                tags.get(k) in {"track", "separate", "protected_lane"}
                for k in [
                    "cycleway",
                    "cycleway:left",
                    "cycleway:right",
                    "cycleway:both",
                ]
            ):
                stress *= 0.35
            surface = tags.get("surface", "unknown")
            surface = "paved" if surface in PAVED else surface
            uncertainty = min(
                1,
                (0.55 if surface == "unknown" else 0.1)
                + (0.15 if grade_samples is None else 0)
                + (
                    0.15
                    if highway in {"path", "track"} and "bicycle" not in tags
                    else 0
                ),
            )
            base = {
                "way": str(way["id"]),
                "length": round(length, 2),
                "surface": surface,
                "highway": highway,
                "tags": {k: tags[k] for k in ("bicycle", "tracktype", "smoothness", "sac_scale", "mtb:scale", "mtb:scale:uphill", "mtb:scale:downhill", "incline", "width") if k in tags},
                "stress": stress,
                "uncertainty": uncertainty,
                "utility": 0,
                "quality": edge_quality(highway, surface, tags, stress),
                "forest": edge_forest_fraction(coords, length, forest_geom),
                "bridge": bridge,
                "tunnel": tunnel,
                "name": tags.get("name", ""),
                "tile": f"{math.floor(coords[0][0] * 20)}_{math.floor(coords[0][1] * 20)}",
            }
            forward, backward = directions(tags)
            if forward:
                edges.append(
                    {
                        **base,
                        "id": len(edges),
                        "from": ids[0],
                        "to": ids[-1],
                        "geometry": coords,
                        "grades": grade_samples,
                    }
                )
            if backward:
                edges.append(
                    {
                        **base,
                        "id": len(edges),
                        "from": ids[-1],
                        "to": ids[0],
                        "geometry": coords[::-1],
                        "grades": [
                            [meters, -grade] for meters, grade in grade_samples[::-1]
                        ]
                        if grade_samples
                        else None,
                    }
                )
            node_ids.update([ids[0], ids[-1]])
    # Reachable low-stress length within 1km, calculated before partitioning.
    adjacency = defaultdict(list)
    for edge in edges:
        if edge["stress"] < 0.4:
            adjacency[edge["from"]].append(edge)
    utility = {}
    for origin in sorted(node_ids):
        queue = [(0, origin)]
        best = {origin: 0}
        reach = 0
        seen_ways = set()
        while queue:
            cost, node = heapq.heappop(queue)
            if cost != best[node]:
                continue
            for edge in adjacency[node]:
                key = (
                    edge["way"],
                    min(edge["from"], edge["to"]),
                    max(edge["from"], edge["to"]),
                )
                if key not in seen_ways:
                    reach += min(edge["length"], 1000 - cost)
                    seen_ways.add(key)
                new = cost + edge["length"]
                if new <= 1000 and new < best.get(edge["to"], math.inf):
                    best[edge["to"]] = new
                    heapq.heappush(queue, (new, edge["to"]))
        utility[origin] = round(min(1, math.log1p(reach) / math.log1p(15000)), 3)
    for edge in edges:
        edge["utility"] = utility[edge["to"]]
    # Junction severity: multiple converging ways onto a busy road class, scored at the arrival node.
    JUNCTION_CLASS_WEIGHT = {
        "primary": 1.0,
        "primary_link": 1.0,
        "secondary": 0.7,
        "secondary_link": 0.7,
        "tertiary": 0.4,
        "tertiary_link": 0.4,
        "unclassified": 0.25,
        "residential": 0.15,
        "living_street": 0.05,
        "service": 0.05,
        "cycleway": 0.0,
    }
    node_degree = Counter()
    node_max_class = defaultdict(float)
    for edge in edges:
        node_degree[edge["from"]] += 1
        node_degree[edge["to"]] += 1
        weight = JUNCTION_CLASS_WEIGHT.get(edge["highway"], 0.1)
        node_max_class[edge["from"]] = max(node_max_class[edge["from"]], weight)
        node_max_class[edge["to"]] = max(node_max_class[edge["to"]], weight)
    node_junction = {
        n: round(min(1, node_max_class[n] * min(1, max(0, node_degree[n] / 2 - 1) / 3)), 3)
        for n in node_ids
    }
    for edge in edges:
        edge["junction"] = node_junction[edge["to"]]
    # Reward-potential field: decayed distance, riding the actual allowed direction, to the
    # nearest attractor (viewpoint/peak, forest, golden gravel) ahead — a reverse multi-source
    # Dijkstra over the reversed graph, so cost of a hard section can be discounted when
    # something rewarding follows soon after.
    REWARD_TAU = 600.0
    REWARD_FLOOR = 0.02
    REWARD_HORIZON = REWARD_TAU * math.log(1 / REWARD_FLOOR)
    QUALITY_SOURCE_THRESHOLD = 0.7
    FOREST_SOURCE_THRESHOLD = 0.6
    SOURCE_STRENGTH = {"viewpoint": 1.0, "quality": 0.7, "forest": 0.5}

    def source_strength(edge):
        strength = 0.0
        if near_viewpoint(edge["geometry"], vp_index):
            strength = max(strength, SOURCE_STRENGTH["viewpoint"])
        if edge["quality"] >= QUALITY_SOURCE_THRESHOLD:
            strength = max(strength, SOURCE_STRENGTH["quality"])
        if edge["forest"] >= FOREST_SOURCE_THRESHOLD:
            strength = max(strength, SOURCE_STRENGTH["forest"])
        return strength

    reverse_adj = defaultdict(list)
    for edge in edges:
        reverse_adj[edge["to"]].append((edge["from"], edge["length"]))
    node_reward_dist = {}
    queue = []
    for edge in edges:
        strength = source_strength(edge)
        if strength <= 0:
            continue
        d0 = -REWARD_TAU * math.log(strength)
        for n in (edge["from"], edge["to"]):
            if d0 < node_reward_dist.get(n, math.inf):
                node_reward_dist[n] = d0
                heapq.heappush(queue, (d0, n))
    while queue:
        d, node = heapq.heappop(queue)
        if d != node_reward_dist.get(node) or d > REWARD_HORIZON:
            continue
        for neighbor, length in reverse_adj[node]:
            nd = d + length
            if nd <= REWARD_HORIZON and nd < node_reward_dist.get(neighbor, math.inf):
                node_reward_dist[neighbor] = nd
                heapq.heappush(queue, (nd, neighbor))
    for edge in edges:
        d = node_reward_dist.get(edge["to"], math.inf)
        edge["reward"] = round(math.exp(-d / REWARD_TAU), 3) if d <= REWARD_HORIZON else 0.0
    nodes = [
        {"id": id, "p": positions[id], "elevation": elevations.get(id)}
        for id in sorted(node_ids)
    ]
    graph = {
        "schemaVersion": 1,
        "bbox": BBOX,
        "nodes": nodes,
        "edges": edges,
        "restrictions": restrictions,
    }
    features = []
    for w in ways:
        coords = [[p["lon"], p["lat"]] for p in w["geometry"] if "lon" in p]
        if len(coords) > 1:
            features.append(
                {
                    "type": "Feature",
                    "properties": {"kind": "road", "class": w["tags"]["highway"]},
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
    for element in elements:
        tags = element.get("tags", {})
        if element["type"] == "node" and tags.get("place"):
            features.append(
                {
                    "type": "Feature",
                    "properties": {"kind": "place", "name": tags.get("name", "")},
                    "geometry": {
                        "type": "Point",
                        "coordinates": [element["lon"], element["lat"]],
                    },
                }
            )
        if element["type"] == "node" and (
            tags.get("tourism") == "viewpoint" or tags.get("natural") == "peak"
        ):
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "peak" if tags.get("natural") == "peak" else "viewpoint",
                        "name": tags.get("name", ""),
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": [element["lon"], element["lat"]],
                    },
                }
            )
        if (
            element["type"] == "way"
            and "highway" not in tags
            and element.get("geometry")
        ):
            coords = [[p["lon"], p["lat"]] for p in element["geometry"] if "lon" in p]
            if len(coords) < 2:
                continue
            is_forest = tags.get("landuse") == "forest" or tags.get("natural") == "wood"
            closed = coords[0] == coords[-1] and len(coords) > 3
            polygon = tags.get("natural") == "water" and closed
            if is_forest and closed:
                features.append(
                    {
                        "type": "Feature",
                        "properties": {"kind": "forest"},
                        "geometry": {"type": "Polygon", "coordinates": [coords]},
                    }
                )
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {"kind": "water" if polygon else "river"},
                    "geometry": {
                        "type": "Polygon" if polygon else "LineString",
                        "coordinates": [coords] if polygon else coords,
                    },
                }
            )
    output.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "graph.json": graph,
        "basemap.json": {"type": "FeatureCollection", "features": features},
    }
    files = []
    for name, value in artifacts.items():
        blob = json.dumps(value, separators=(",", ":")).encode()
        (output / name).write_bytes(blob)
        files.append(
            {
                "path": name,
                "bytes": len(blob),
                "sha256": hashlib.sha256(blob).hexdigest(),
            }
        )
    version = hashlib.sha256("".join(f["sha256"] for f in files).encode()).hexdigest()[
        :16
    ]
    manifest = {
        "schemaVersion": 1,
        "id": "geneva",
        "name": "Geneva basin",
        "version": version,
        "bbox": BBOX,
        "osmTimestamp": raw.get("osm3s", {}).get("timestamp_osm_base", "unknown"),
        "costModelVersion": 3,
        "terrainSource": "Mapterhorn Terrarium z12" if terrain else None,
        "terrainCoverage": round(
            sum(e["grades"] is not None for e in edges) / max(1, len(edges)), 3
        ),
        "attribution": "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn (see source attribution)",
        "files": files,
        "build": {
            "nodes": len(nodes),
            "edges": len(edges),
            "restrictions": len(restrictions),
            **counts,
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/osm.json")
    parser.add_argument("--output", default="data/build/geneva")
    parser.add_argument("--no-terrain", action="store_true")
    args = parser.parse_args()
    build(Path(args.input), Path(args.output), not args.no_terrain)
