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
            red, green, blue = img.getpixel((min(511, int(px)), min(511, int(py))))
            elevations[id] = round(red * 256 + green + blue / 256 - 32768, 1)
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
        start = 0
        for i in range(1, len(sequence)):
            if sequence[i] not in kept and i < len(sequence) - 1:
                continue
            ids = sequence[start : i + 1]
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
            grade_samples = None
            if all(id in elevations for id in ids) and not (bridge or tunnel):
                # Sample a smoothed 80m profile rather than treating DEM pixel steps as road grades.
                sample_indices = [0]
                acc = 0
                for j, segment_length in enumerate(lengths, 1):
                    acc += segment_length
                    if acc >= 80 or j == len(ids) - 1:
                        sample_indices.append(j)
                        acc = 0
                grade_samples = []
                for a, b in zip(sample_indices, sample_indices[1:]):
                    meters = sum(lengths[a:b])
                    grade = (elevations[ids[b]] - elevations[ids[a]]) / max(meters, 1)
                    # Clamp rather than discard: extreme DEM samples are still real
                    # terrain and must keep incurring slope cost, not fall to zero.
                    grade = max(-0.45, min(0.45, grade))
                    grade_samples.append([round(meters, 2), round(grade, 5)])
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
                "stress": stress,
                "uncertainty": uncertainty,
                "utility": 0,
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
        if (
            element["type"] == "way"
            and "highway" not in tags
            and element.get("geometry")
        ):
            coords = [[p["lon"], p["lat"]] for p in element["geometry"] if "lon" in p]
            if len(coords) < 2:
                continue
            polygon = (
                tags.get("natural") == "water"
                and coords[0] == coords[-1]
                and len(coords) > 3
            )
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
        "costModelVersion": 1,
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
