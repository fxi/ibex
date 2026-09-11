"""Diff two generated graphs edge by edge.

Used for two checks the release depends on:

1. Source equivalence — the pbf pipeline must reproduce the Overpass build for the same
   bbox, or the osmium tag filters lost something.
2. Halo exactness — a cell built with a halo must produce identical attributes to the same
   area built as part of a larger region, or the bounded post-passes (utility 1 km,
   reward 2,347 m) are leaking across cell borders.

Edges are matched on (way, from, to) rather than id, so a build whose edge ids changed can
still be compared against one whose ids were a per-build counter.
"""

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

# Attributes compared exactly; anything derived from a bounded pass belongs here because a
# halo that is too small shows up as a difference in exactly these.
EXACT = ("surface", "highway", "bridge", "tunnel", "name", "ferryService")
NUMERIC = (
    "length",
    "stress",
    "uncertainty",
    "utility",
    "urban",
    "cyclingNetwork",
    "quality",
    "forest",
    "reward",
    "junction",
    "ferrySeconds",
)
TOLERANCE = 5e-4


def load(directory):
    directory = Path(directory)
    graph = json.loads((directory / "graph.json").read_text())
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    return graph, manifest


def edge_key(edge):
    return (edge["way"], edge["from"], edge["to"])


def in_bbox(point, bbox):
    return bbox[0] <= point[0] <= bbox[2] and bbox[1] <= point[1] <= bbox[3]


def way_level(base_graph, cand_graph, bbox):
    """Compare per way, not per (way, from, to).

    Edge keys embed node ids, so a mapper adding a node or re-splitting a way changes the
    key without changing the road — that shows up as a missing edge and a new edge at once.
    Way ids plus total length are immune to renumbering, which makes this the right metric
    when the two builds read different OSM editions. For a halo check, where both sides read
    identical data, the stricter edge-level comparison above is the one that matters.
    """
    def index(graph):
        ways, length = set(), {}
        for edge in graph["edges"]:
            if bbox and not in_bbox(edge["geometry"][0], bbox):
                continue
            ways.add(edge["way"])
            length[edge["way"]] = length.get(edge["way"], 0.0) + edge["length"]
        return ways, length

    base_ways, base_length = index(base_graph)
    cand_ways, cand_length = index(cand_graph)
    shared = base_ways & cand_ways
    base_total = sum(base_length[w] for w in shared)
    cand_total = sum(cand_length[w] for w in shared)
    drift = [
        (abs(cand_length[w] - base_length[w]), w, base_length[w], cand_length[w])
        for w in shared
    ]
    drift.sort(reverse=True)
    return {
        "baseWays": len(base_ways),
        "candWays": len(cand_ways),
        "shared": len(shared),
        "sharedShare": len(shared) / len(base_ways) if base_ways else 0.0,
        "onlyBase": len(base_ways - cand_ways),
        "onlyCand": len(cand_ways - base_ways),
        "sharedKmBase": base_total / 1000,
        "sharedKmCand": cand_total / 1000,
        "sharedKmDrift": (cand_total - base_total) / base_total if base_total else 0.0,
        "worstDrift": drift[:5],
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument(
        "--bbox",
        default=None,
        help="Only compare edges whose first point is inside w,s,e,n. Use when the "
        "candidate was built with a halo and legitimately holds extra edges.",
    )
    parser.add_argument("--max-report", type=int, default=12)
    parser.add_argument(
        "--tolerance", type=float, default=TOLERANCE, help="Numeric attribute tolerance"
    )
    parser.add_argument(
        "--allow-missing-fraction",
        type=float,
        default=0.0,
        help="Fail unless matched edges are at least this fraction of the baseline.",
    )
    args = parser.parse_args()

    base_graph, base_manifest = load(args.baseline)
    cand_graph, cand_manifest = load(args.candidate)
    bbox = [float(v) for v in args.bbox.split(",")] if args.bbox else None

    def index(graph):
        edges = {}
        for edge in graph["edges"]:
            if bbox and not in_bbox(edge["geometry"][0], bbox):
                continue
            edges[edge_key(edge)] = edge
        return edges

    base = index(base_graph)
    cand = index(cand_graph)
    base_nodes = {n["id"] for n in base_graph["nodes"]}
    cand_nodes = {n["id"] for n in cand_graph["nodes"]}

    print(f"baseline   {args.baseline}")
    print(f"candidate  {args.candidate}")
    if bbox:
        print(f"restricted to {bbox}")
    print()
    print(f"{'metric':<26} {'baseline':>12} {'candidate':>12} {'delta':>10}")

    def row(name, a, b):
        delta = b - a
        share = f"{delta:+.2%}" if a and abs(delta / a) < 10 else f"{delta:+d}"
        print(f"{name:<26} {a:>12,} {b:>12,} {share:>10}")

    row("nodes", len(base_nodes), len(cand_nodes))
    row("directed edges", len(base), len(cand))
    row("restrictions", len(base_graph["restrictions"]), len(cand_graph["restrictions"]))
    for key in ("terrainCoverage",):
        a, b = base_manifest.get(key), cand_manifest.get(key)
        if a is not None and b is not None:
            print(f"{key:<26} {a:>12} {b:>12} {b - a:>+10.4f}")

    only_base = set(base) - set(cand)
    only_cand = set(cand) - set(base)
    shared = set(base) & set(cand)
    print()
    print(f"matched edges        {len(shared):,}")
    print(f"only in baseline     {len(only_base):,}")
    print(f"only in candidate    {len(only_cand):,}")

    for label, missing in (("baseline", only_base), ("candidate", only_cand)):
        if not missing:
            continue
        source = base if label == "baseline" else cand
        highways = Counter(source[k]["highway"] for k in missing)
        print(f"  only in {label}, by highway: {dict(highways.most_common(8))}")
        for key in list(sorted(missing))[: args.max_report]:
            edge = source[key]
            print(
                f"    way {edge['way']:>12} {edge['from']}->{edge['to']} "
                f"{edge['highway']:<14} {edge['length']:>8.1f} m"
            )

    mismatch = Counter()
    worst = {}
    for key in shared:
        a, b = base[key], cand[key]
        for field in EXACT:
            if a.get(field) != b.get(field):
                mismatch[field] += 1
        for field in NUMERIC:
            x, y = a.get(field), b.get(field)
            if x is None and y is None:
                continue
            if x is None or y is None:
                mismatch[field] += 1
                continue
            gap = abs(x - y)
            if gap > args.tolerance:
                mismatch[field] += 1
                if gap > worst.get(field, (0,))[0]:
                    worst[field] = (gap, key, x, y)
        if (a.get("grades") is None) != (b.get("grades") is None):
            mismatch["grades:presence"] += 1
        if len(a["geometry"]) != len(b["geometry"]):
            mismatch["geometry:length"] += 1

    print()
    if mismatch:
        print("attribute differences among matched edges:")
        for field, count in mismatch.most_common():
            extra = ""
            if field in worst:
                gap, key, x, y = worst[field]
                extra = f"  worst {gap:.6g} (way {key[0]}: {x} vs {y})"
            print(f"  {field:<20} {count:>8,} / {len(shared):,}{extra}")
    else:
        print("attribute differences among matched edges: none")

    ways = way_level(base_graph, cand_graph, bbox)
    print()
    print("way-level comparison (immune to node renumbering and re-splitting):")
    print(f"  baseline ways with edges   {ways['baseWays']:>10,}")
    print(f"  candidate ways with edges  {ways['candWays']:>10,}")
    print(
        f"  shared ways                {ways['shared']:>10,}"
        f"   ({ways['sharedShare']:.2%} of baseline)"
    )
    print(f"  only in baseline           {ways['onlyBase']:>10,}")
    print(f"  only in candidate          {ways['onlyCand']:>10,}")
    print(
        f"  shared-way length          {ways['sharedKmBase']:>10,.0f} km vs "
        f"{ways['sharedKmCand']:,.0f} km   ({ways['sharedKmDrift']:+.3%})"
    )
    for gap, way, a, b in ways["worstDrift"]:
        print(f"    way {way:>12}  {a:>9.1f} -> {b:>9.1f} m  ({gap:+.1f})")

    matched_share = len(shared) / len(base) if base else 0
    print(f"\nmatched share of baseline: {matched_share:.4%}")
    if matched_share < args.allow_missing_fraction:
        print(
            f"FAIL: below required {args.allow_missing_fraction:.4%}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
