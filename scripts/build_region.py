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
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from cost_model_version import COST_MODEL_VERSION
from grid import cell_bbox, cell_id, mercator_x, mercator_y, tile_of
from PIL import Image
from prepare_tracks import BBOX, distance
from profile_features import (
    cycling_memberships,
    ferry_ways,
    on_cycling_network,
    tagged_polygons,
    urban_fraction,
    urban_index,
)
from region_config import HALO_KM, PREPROCESSOR_VERSION, TERRAIN_ZOOM, halo_degrees
from shapely.geometry import Point
from shapely.ops import unary_union
from shapely.prepared import prep
from terrain_profile import bilinear_height, slice_profile, structure_grade, way_profile

DENIED = {"no", "private", "use_sidepath"}
PAVED = {"asphalt", "concrete", "concrete:plates", "paving_stones", "paved"}


def permitted(tags):
    access = tags.get("bicycle", tags.get("vehicle", tags.get("access", "yes")))
    if access in DENIED:
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
    if (highway == "steps" or access == "dismount") and tags.get("foot", tags.get("access", "yes")) in {"no", "private"}:
        return False
    return bool(highway) or tags.get("route") == "ferry"


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
    return tagged_polygons(elements, lambda t: t.get("landuse") == "forest" or t.get("natural") == "wood")


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


# Deterministic edge identity. The same physical segment must get the same id in every cell
# that contains it, which is what lets two adjacent packs deduplicate a boundary edge instead
# of routing over it twice. OSM way ids are below 2^31 and the API caps a way at 2,000 nodes,
# so 12 bits of segment index is provably enough and the whole id stays inside 2^53 — exactly
# representable as a JavaScript number, which Edge.id has to be.
SEGMENT_SLOTS = 4096


def edge_uid(way_id, segment_index, direction):
    """(way, segment, direction) -> a stable 44-bit id. Replaces a per-build counter."""
    if not 0 <= segment_index < SEGMENT_SLOTS:
        raise ValueError(
            f"Way {way_id} segment index {segment_index} exceeds {SEGMENT_SLOTS} slots"
        )
    return (way_id * SEGMENT_SLOTS + segment_index) * 2 + direction


def tile_coord(p, z=TERRAIN_ZOOM):
    """Tile x/y plus the pixel offset inside a 512 px tile, sharing grid.py's projection."""
    n = 2**z
    x = mercator_x(p[0]) * n
    y = mercator_y(p[1]) * n
    return int(x), int(y), (x % 1) * 512, (y % 1) * 512


def terrain_samples(points, cache, enabled, zoom=TERRAIN_ZOOM):
    """Sample Terrarium elevations tile by tile.

    Grouping points by tile keeps exactly one decoded image resident. Holding every tile at
    once was fine for the ~30 tiles a single region needed and is several GB for the
    thousands a full release needs. bilinear_height clamps to the tile's own pixels rather
    than reading across a boundary, so this is numerically identical to the old behaviour.
    """
    if not enabled:
        return {}
    cache.mkdir(parents=True, exist_ok=True)
    by_tile = defaultdict(list)
    for id, p in points.items():
        x, y, px, py = tile_coord(p, zoom)
        by_tile[(x, y)].append((id, px, py))

    def download(key):
        x, y = key
        path = cache / f"{zoom}-{x}-{y}.webp"
        if path.exists():
            return key, path
        try:
            response = httpx.get(
                f"https://tiles.mapterhorn.com/{zoom}/{x}/{y}.webp", timeout=40
            )
            response.raise_for_status()
            Image.open(io.BytesIO(response.content)).verify()
            # Adjacent cell processes share this cache and may fetch the same
            # tile at once. Each writer needs its own temporary file.
            with tempfile.NamedTemporaryFile(dir=cache, suffix=".partial", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(response.content)
            try:
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
            return key, path
        except (httpx.HTTPError, OSError):
            return key, None

    missing = sum(1 for key in by_tile if not (cache / f"{zoom}-{key[0]}-{key[1]}.webp").exists())
    if missing:
        print(f"Fetching {missing} of {len(by_tile)} terrain tiles at zoom {zoom}", flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = dict(pool.map(download, sorted(by_tile)))

    elevations = {}
    absent = 0
    for key in sorted(by_tile):
        path = paths.get(key)
        if path is None:
            absent += 1
            continue
        try:
            with Image.open(path) as image:
                rgb = image.convert("RGB")
                for id, px, py in by_tile[key]:
                    elevations[id] = bilinear_height(rgb, px, py)
        except OSError:
            absent += 1
    if absent:
        print(f"  {absent} terrain tiles unavailable", flush=True)
    return elevations


def read_source(source):
    """Elements plus provenance, from either a pbf extract or the Overpass JSON snapshot."""
    if str(source).endswith(".pbf"):
        from osm_source import load_elements

        # Same naming clip_region.py writes: foo.osm.pbf -> foo.osm.source.json
        stamp = Path(source).with_suffix(".source.json")
        meta = json.loads(stamp.read_text()) if stamp.exists() else {}
        return (
            load_elements(source),
            meta.get("osmTimestamp") or "unknown",
            meta.get("inputs", {}).get("sources", {}),
        )
    raw = json.loads(source.read_bytes())
    # Overpass output sets may repeat elements; retain the richest geometry.
    unique = {}
    for element in raw["elements"]:
        key = (element["type"], element["id"])
        if key not in unique or len(json.dumps(element)) > len(json.dumps(unique[key])):
            unique[key] = element
    return (
        list(unique.values()),
        raw.get("osm3s", {}).get("timestamp_osm_base", "unknown"),
        raw.get("sources", []),
    )


# A cell whose DEM tiles partly failed carries no grades on the affected edges, which reads
# as flat ground where there is a climb. Recording that in the manifest was not enough: the
# build has to refuse it, because nothing downstream looks.
MIN_TERRAIN_COVERAGE = 0.98


def network_utility(edges, node_ids):
    """How much low-stress network a node sits in: reachable low-stress length within 1 km.

    A bounded Dijkstra per node. The same physical segment counts once however many
    directions it carries. Run before partitioning, over the cell plus its halo, so a node
    near a cell edge gets the answer it would in a whole-region build.
    """
    # Reachable low-stress length within 1km, calculated before partitioning.
    adjacency = defaultdict(list)
    for edge in edges:
        if edge["stress"] < 0.4 and edge["highway"] not in {"steps", "ferry"}:
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
    return utility


def junction_severity(edges, node_ids):
    """How hard the junction at each node is: how many ways converge, on what road class.

    Scored at the node, so both directions of an edge arriving there agree.
    """
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
    return node_junction


def reward_potential(edges, vp_index):
    """How close each node is to something worth riding to, decayed by distance.

    A reverse multi-source Dijkstra from every attractor (viewpoint or peak, forest, golden
    gravel), seeded at both ends of the attractor edge and propagated over the reversed
    graph — riding the direction actually allowed — so the cost of a hard section can be
    discounted when the reward follows soon after.
    """
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
    return {
        node: round(math.exp(-d / REWARD_TAU), 3)
        for node, d in node_reward_dist.items()
        if d <= REWARD_HORIZON
    }


def basemap_features(ways, elements):
    """The self-contained basemap a cell ships: roads, places, peaks, forest and water.

    Purely presentational, and a pure function of the source elements: it shares nothing
    with the routing graph, which is why it can be read and changed without the graph in
    mind.
    """
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
            tags.get("tourism") == "viewpoint" or tags.get("natural") in {"peak", "saddle"}
            or tags.get("mountain_pass") == "yes"
        ):
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "kind": ("pass" if tags.get("natural") == "saddle" or tags.get("mountain_pass") == "yes"
                                 else "peak" if tags.get("natural") == "peak" else "viewpoint"),
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
            and (tags.get("natural") in {"wood", "water"} or tags.get("landuse") == "forest" or "waterway" in tags)
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
    return features


def build(
    source,
    output,
    terrain=True,
    cell=None,
    split_nodes=None,
    min_terrain_coverage=MIN_TERRAIN_COVERAGE,
):
    elements, osm_timestamp, source_layers = read_source(source)
    print(f"Preparing profile features for {len(elements)} OSM elements", flush=True)
    ferries = ferry_ways(elements, distance)
    for element in elements:
        if element["type"] == "way" and element["id"] in ferries:
            element["tags"] = {**ferries[element["id"]][0], "highway": "ferry"}
    networks = cycling_memberships(elements)
    urban = urban_index(elements)
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
            or e.get("tags", {}).get("natural") == "saddle"
            or e.get("tags", {}).get("mountain_pass") == "yes"
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
    print(f"Sampling terrain for {len(positions)} positions", flush=True)
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
    if split_nodes is not None:
        # Release-wide split points: every cell cuts ways at exactly the same nodes, so a
        # boundary segment gets one identity no matter which cell encodes it.
        kept = split_nodes
    else:
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
        # One unresolved node discards the whole way, including the parts that are located.
        # Rare with complete_ways extracts, which is exactly why it is counted: if it ever
        # stops being rare, nothing else here would say so.
        if any(node not in positions for node in sequence):
            counts["waysMissingPositions"] += 1
            continue
        offsets, profile = way_profile(sequence, positions, elevations, tags.get("incline"))
        # A structure is never sampled from the DEM: it sees the valley below a bridge and
        # the mountain above a tunnel. One tagged-or-flat grade serves every segment.
        structure = (
            structure_grade(tags.get("incline"))
            if tags.get("bridge", "no") != "no" or tags.get("tunnel", "no") != "no"
            else None
        )
        start = 0
        for i in range(1, len(sequence)):
            if sequence[i] not in kept and i < len(sequence) - 1:
                continue
            ids = sequence[start : i + 1]
            profile_start = offsets[start]
            profile_end = offsets[i]
            # Index of the segment's first node within the way, not the running counter.
            segment_index = start
            start = i
            if any(id not in positions for id in ids) or any(
                id in blocked for id in ids
            ):
                continue
            coords = [positions[id] for id in ids]
            # Keep the graph inside declared coverage; boundary connectors are retained
            # only when fully covered. In cell mode the pbf is already the cell plus its
            # halo and the halo is trimmed after the bounded passes instead.
            if cell is None and any(
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
            if tags["highway"] == "ferry":
                grade_samples = None
            elif bridge or tunnel:
                grade_samples = (
                    None
                    if structure is None
                    else [[round(length, 3), round(structure, 5)]]
                )
            else:
                grade_samples = slice_profile(profile, profile_start, profile_end)
            # A structure's grade is tagged or flat, never measured from terrain.
            estimated = grade_samples is None or bridge or tunnel
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
                + (0.15 if estimated else 0)
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
                "tags": {k: tags[k] for k in ("bicycle", "vehicle", "access", "foot", "route", "duration", "interval", "opening_hours", "seasonal", "step_count", "ramp:bicycle", "tracktype", "smoothness", "sac_scale", "mtb:scale", "mtb:scale:uphill", "mtb:scale:downhill", "incline", "width") if k in tags},
                "stress": round(stress, 3),
                "uncertainty": round(uncertainty, 3),
                "utility": 0,
                "urban": urban_fraction(coords, tags, urban),
                "quality": edge_quality(highway, surface, tags, stress),
                "forest": edge_forest_fraction(coords, length, forest_geom),
                "bridge": bridge,
                "tunnel": tunnel,
                "name": tags.get("name", ""),
                "tile": f"{math.floor(coords[0][0] * 20)}_{math.floor(coords[0][1] * 20)}",
            }
            if highway == "ferry":
                _, service, seconds = ferries[way["id"]]
                base["ferryService"] = service
                if seconds is not None and offsets[-1] > 0:
                    base["ferrySeconds"] = round(seconds * length / offsets[-1], 3)
                base["stress"] = 0
                base["uncertainty"] = 0.1 if seconds is not None else 0.4
                counts["ferrySegments"] += 1
            if highway == "steps":
                counts["stepsSegments"] += 1
            forward, backward = directions(tags)
            if forward:
                edges.append(
                    {
                        **base,
                        "id": edge_uid(way["id"], segment_index, 0),
                        "cyclingNetwork": on_cycling_network(way, "forward", networks),
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
                        "id": edge_uid(way["id"], segment_index, 1),
                        "cyclingNetwork": on_cycling_network(way, "backward", networks),
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
    print(f"Built {len(edges)} directed edges; calculating network utility", flush=True)
    utility = network_utility(edges, node_ids)
    for edge in edges:
        edge["utility"] = utility[edge["to"]]
    node_junction = junction_severity(edges, node_ids)
    for edge in edges:
        edge["junction"] = node_junction[edge["to"]]
    reward = reward_potential(edges, vp_index)
    for edge in edges:
        edge["reward"] = reward.get(edge["to"], 0.0)
    # Halo trim. Everything above ran over the cell plus its halo, so the bounded passes
    # (utility 1 km, junction node-local, reward 2,347 m) saw every neighbour that can
    # influence an edge this cell owns, making their results identical to a whole-region
    # run. Only now is the graph reduced to what the cell publishes: an edge belongs to the
    # cell containing its FIRST geometry point, a property of the road itself, so adjacent
    # cells agree on the owner without consulting each other.
    if cell is not None:
        cell_zoom, cell_x, cell_y = cell
        owned = [
            edge
            for edge in edges
            if tile_of(edge["geometry"][0], cell_zoom) == (cell_x, cell_y)
        ]
        bounds = cell_bbox(cell_zoom, cell_x, cell_y)
        halo_lon, halo_lat = halo_degrees(bounds, HALO_KM)
        overshoot = 0.0
        for edge in owned:
            for p in edge["geometry"]:
                overshoot = max(
                    overshoot,
                    bounds[0] - p[0],
                    p[0] - bounds[2],
                    bounds[1] - p[1],
                    p[1] - bounds[3],
                )
        counts["haloOvershootKm"] = round(max(0.0, overshoot) * 111.32, 3)
        counts["haloEdgesDropped"] = len(edges) - len(owned)
        # With a global split-node set the edge ids are identical in every cell regardless
        # of halo size, so an edge reaching past the halo no longer threatens deduplication.
        # It does mean the bounded passes saw partial context at that edge's far end, so the
        # count is reported. The cap only catches a genuinely broken extract.
        far = 0
        for edge in owned:
            for p in edge["geometry"]:
                if not (
                    bounds[0] - halo_lon <= p[0] <= bounds[2] + halo_lon
                    and bounds[1] - halo_lat <= p[1] <= bounds[3] + halo_lat
                ):
                    far += 1
                    break
        counts["edgesBeyondHalo"] = far
        if split_nodes is None and counts["haloOvershootKm"] > HALO_KM:
            raise ValueError(
                f"Cell {cell_id(cell_zoom, cell_x, cell_y)} owns an edge reaching "
                f"{counts['haloOvershootKm']:.2f} km past its bounds with no global "
                f"split-node set; run global_splits.py first"
            )
        # Scheduled ferries legitimately run hundreds of km (Marseille to Tangier, Corsica),
        # so only road edges are held to the broken-extract cap.
        road_overshoot = max(
            (
                max(bounds[0] - p[0], p[0] - bounds[2], bounds[1] - p[1], p[1] - bounds[3])
                for edge in owned
                if edge["highway"] != "ferry"
                for p in edge["geometry"]
            ),
            default=0.0,
        ) * 111.32
        if road_overshoot > 200:
            raise ValueError(
                f"Cell {cell_id(cell_zoom, cell_x, cell_y)} owns an edge reaching "
                f"{road_overshoot:.2f} km past its bounds; the extract is wrong"
            )
        edges = owned
        node_ids = {id for edge in edges for id in (edge["from"], edge["to"])}
        present_ways = {edge["way"] for edge in edges}
        restrictions = [
            r for r in restrictions if all(w in present_ways for w in r["ways"])
        ]
        graph_bbox = list(bounds)
    else:
        graph_bbox = BBOX
    nodes = [
        {
            "id": id,
            "p": positions[id],
            "elevation": None
            if elevations.get(id) is None
            else round(elevations[id], 2),
        }
        for id in sorted(node_ids)
    ]
    graph = {
        "schemaVersion": 1,
        "bbox": graph_bbox,
        "nodes": nodes,
        "edges": edges,
        "restrictions": restrictions,
    }
    features = basemap_features(ways, elements)
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
    coverage = round(
        sum(e["grades"] is not None for e in edges) / max(1, len(edges)), 3
    )
    # Before the manifest, which is the sentinel build_cells.py resumes on: a cell that
    # fails here leaves no manifest and is rebuilt, rather than being packaged as sound.
    if terrain and coverage < min_terrain_coverage:
        raise SystemExit(
            f"Terrain coverage {coverage} is below {min_terrain_coverage}: DEM tiles were "
            f"unavailable for part of this cell. Rebuild once they fetch, or pass "
            f"--min-terrain-coverage to accept the gap deliberately."
        )
    name = cell_id(*cell) if cell else "region"
    manifest = {
        "schemaVersion": 1,
        "id": name,
        "name": name,
        "version": version,
        "bbox": graph_bbox,
        "osmTimestamp": osm_timestamp,
        "costModelVersion": COST_MODEL_VERSION,
        "source": {"osmSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "osmFile": source.name, "preprocessorVersion": PREPROCESSOR_VERSION, "layers": source_layers},
        "terrainSource": f"Mapterhorn Terrarium z{TERRAIN_ZOOM}" if terrain else None,
        "terrainCoverage": coverage,
        "attribution": "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn (see source attribution)",
        "files": files,
        "build": {
            "nodes": len(nodes),
            "edges": len(edges),
            "restrictions": len(restrictions),
            "cyclingNetworkEdges": sum(e["cyclingNetwork"] > 0 for e in edges),
            "urbanEdges": sum(e["urban"] > 0 for e in edges),
            **counts,
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    # Normally invoked per cell by build_cells.py; the pre-grid default paths are gone.
    parser.add_argument("--input", required=True, help="Cell extract (.osm.pbf)")
    parser.add_argument("--output", required=True, help="Cell build directory")
    parser.add_argument("--no-terrain", action="store_true")
    parser.add_argument(
        "--min-terrain-coverage",
        type=float,
        default=MIN_TERRAIN_COVERAGE,
        help="Fail the build below this share of edges carrying grades",
    )
    parser.add_argument(
        "--split-nodes",
        default=None,
        help="Release-wide split-node set from global_splits.py. Required for cell builds "
        "so every cell cuts ways at the same nodes.",
    )
    parser.add_argument(
        "--cell",
        default=None,
        help="Build one download cell (e.g. 9-264-181) from a cell extract, trimming the "
        "halo after the bounded passes run.",
    )
    args = parser.parse_args()
    source = Path(args.input)
    if not str(source).endswith(".pbf"):
        metadata = source.with_suffix(".source.json")
        if (
            not metadata.exists()
            or json.loads(metadata.read_text()).get("extractVersion") != 4
        ):
            raise ValueError("Fetch a version-4 extract before building the region.")
    cell = None
    if args.cell:
        from grid import parse_cell_id

        cell = parse_cell_id(args.cell)
    split_nodes = None
    if args.split_nodes:
        from global_splits import load

        split_nodes = load(args.split_nodes)
        print(f"Loaded {len(split_nodes):,} release-wide split nodes", flush=True)
    build(
        source,
        Path(args.output),
        not args.no_terrain,
        cell,
        split_nodes,
        args.min_terrain_coverage,
    )
